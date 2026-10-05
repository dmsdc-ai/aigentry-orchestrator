import * as fs from "node:fs";
import * as path from "node:path";
import { winPrivateStorage } from "./private-storage.js";
import type { VerifyItem, VerifyResult, WinPrivateStorage } from "./private-storage.js";

// #652 opt-in long-lived Claude worker token (`claude setup-token`). The raw value
// is written only to one private per-attempt handoff file and the actual worker
// child env. The opt-in var itself is still inherited, same-user, by launcher
// ancestors (boot-prepare, open-session.sh, the sandbox runner until it wipes its
// env before SRT init). Every error is a fixed string: no value, length, path
// detail or parser output can leak through stderr, traces or REPORTs.
export const CLAUDE_OAUTH_OPT_IN = "AIGENTRY_CLAUDE_OAUTH_TOKEN";
export const CLAUDE_OAUTH_CHILD = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_OAUTH_DIR = "claude-oauth";
export const CLAUDE_OAUTH_FILE = "token";
export const CLAUDE_OAUTH_MAX = 4096;

// One line of printable non-space ASCII; rejects NUL, newline, other controls and non-ASCII.
const valid = (v: string): boolean => v.length <= CLAUDE_OAUTH_MAX && /^[\x21-\x7e]+$/.test(v);
const euid = (): number => (process.geteuid ? process.geteuid() : -1);
const literalPath = (p: string): boolean => path.isAbsolute(p) && path.normalize(p) === p && !/[\0\r\n]/.test(p);

/** The opted-in token, or undefined when unset/empty (old behavior). Invalid is a refusal. */
export function selectedClaudeOAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[CLAUDE_OAUTH_OPT_IN];
  if (v === undefined || v === "") return undefined;
  if (!valid(v)) throw new Error("CLAUDE_OAUTH_TOKEN_INVALID");
  return v;
}

// #1167 F6 (win32, P2 + Q-FILE R2): mode bits and uid mean nothing there, so the ACL is read back.
// Every item must verify in ONE read batch (a file only together with its private parent dir).
function verifyWinPrivate(storage: WinPrivateStorage, items: readonly VerifyItem[], refusal: string): readonly VerifyResult[] {
  const results = storage.verify(items);
  if (results.length !== items.length || !results.every((r) => r.ok)) throw new Error(refusal);
  return results;
}

/** A real (non-symlink) directory owned by this user with no group/world bits (win32: verified private). */
function assertPrivateDir(dir: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID"); }
  if (winPrivateStorage) {
    if (!st.isDirectory()) throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
    verifyWinPrivate(winPrivateStorage, [{ path: dir, kind: "directory", want: "private" }], "CLAUDE_OAUTH_HANDOFF_INVALID");
    return;
  }
  if (!st.isDirectory() || st.uid !== euid() || (st.mode & 0o077) !== 0) {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  }
}

/**
 * Exclusively create `<dir>/token` (0600) inside a NEW private directory `dir`
 * (0700, must not exist; its parent must). Returns the exact file path. No
 * cleanup: the file stays for the attempt's lifetime so a relaunch re-reads it.
 */
export function writeClaudeOAuthHandoff(dir: string, token: string): string {
  if (!valid(token)) throw new Error("CLAUDE_OAUTH_TOKEN_INVALID");
  if (!literalPath(dir)) throw new Error("CLAUDE_OAUTH_HANDOFF_WRITE");
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // win32: the P2 Set on the directory this call just created.
    if (winPrivateStorage && winPrivateStorage.setPrivate(dir, "directory").status !== "ok") throw new Error();
  } catch {
    throw new Error("CLAUDE_OAUTH_HANDOFF_WRITE");
  }
  assertPrivateDir(dir);
  const file = path.join(dir, CLAUDE_OAUTH_FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new Error("CLAUDE_OAUTH_HANDOFF_WRITE");
  }
  let written = false;
  try {
    // win32 (R2): the still-empty file verifies together with its parent BEFORE the token is written.
    if (winPrivateStorage) {
      verifyWinPrivate(winPrivateStorage, [{ path: dir, kind: "directory", want: "private" },
        { path: file, kind: "file", want: "private" }], "CLAUDE_OAUTH_HANDOFF_WRITE");
    }
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, token + "\n");
    written = true;
  } catch {
    throw new Error("CLAUDE_OAUTH_HANDOFF_WRITE");
  } finally {
    fs.closeSync(fd);
    // win32: a failed handoff file never stays behind (removed once its handle is closed).
    if (!written && winPrivateStorage) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }
  return file;
}

/**
 * Read the handoff at exactly `expected`: private parent, regular non-symlink
 * file owned by this user, no group/world bits, single link, bounded size,
 * content `<token>\n`. Anything else is a refusal, never a fallback.
 */
export function readClaudeOAuthHandoff(file: unknown, expected: string): string {
  if (typeof file !== "string" || file !== expected || !literalPath(file) ||
      path.basename(file) !== CLAUDE_OAUTH_FILE) {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  }
  // win32 (R2): the parent and the file verify private in ONE batch (lstat-bracketed, so no
  // reparse point); the opened handle must then be that same verified file (dev, ino).
  const verified = winPrivateStorage
    ? verifyWinPrivate(winPrivateStorage, [{ path: path.dirname(file), kind: "directory", want: "private" },
      { path: file, kind: "file", want: "private" }], "CLAUDE_OAUTH_HANDOFF_INVALID")[1]
    : undefined;
  if (!verified) assertPrivateDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  }
  try {
    const st = fs.fstatSync(fd);
    if (verified) {
      const h = fs.fstatSync(fd, { bigint: true });
      if (String(h.dev) !== verified.dev || String(h.ino) !== verified.ino) throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
    }
    if (!st.isFile() || (!verified && (st.uid !== euid() || (st.mode & 0o077) !== 0)) || st.nlink !== 1 ||
        st.size < 2 || st.size > CLAUDE_OAUTH_MAX + 1) {
      throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
    }
    const buf = Buffer.alloc(CLAUDE_OAUTH_MAX + 2);
    let n = 0;
    for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    const raw = buf.subarray(0, n).toString("latin1");
    buf.fill(0);
    const token = raw.endsWith("\n") ? raw.slice(0, -1) : "";
    if (!valid(token)) throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
    return token;
  } catch {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Legacy (unconfined) launcher lines: export CLAUDE_CODE_OAUTH_TOKEN read at
 * launch time from the private handoff, never inlined. The read reuses the
 * bounded Node reader above (owner/mode/nlink/size/symlink/content checks) via
 * an internal pipe capture; no second shell parser. xtrace/verbose are turned
 * off first, NODE_OPTIONS is cleared for the reader, its stderr is discarded,
 * and any failure exits 78 with a fixed message.
 */
export function claudeOAuthLauncherLines(file: string, nodeBin: string, helperModule: string): string {
  if (!literalPath(file) || path.basename(file) !== CLAUDE_OAUTH_FILE ||
      !literalPath(nodeBin) || !literalPath(helperModule)) {
    throw new Error("CLAUDE_OAUTH_HANDOFF_INVALID");
  }
  const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
  const reader = `import(require("node:url").pathToFileURL(process.argv[1]).href)` +
    `.then(m=>{process.stdout.write(m.readClaudeOAuthHandoff(process.argv[2],process.argv[2]))})` +
    `.catch(()=>{process.exitCode=78})`;
  return (
    `# #652 opt-in Claude worker token: read from the private per-attempt handoff, never inlined.\n` +
    `{ set +xv; } 2>/dev/null\n` +
    `__aig_oauth_tok=$(NODE_OPTIONS= ${q(nodeBin)} -e ${q(reader)} ${q(helperModule)} ${q(file)} 2>/dev/null) || __aig_oauth_tok=\n` +
    `if [ -z "$__aig_oauth_tok" ]; then\n` +
    `  unset __aig_oauth_tok\n` +
    `  echo "launcher: Claude worker OAuth handoff missing or malformed; refusing launch (no host-credential fallback)" >&2\n` +
    `  exit 78\n` +
    `fi\n` +
    `export ${CLAUDE_OAUTH_CHILD}="$__aig_oauth_tok"\n` +
    `unset __aig_oauth_tok ${CLAUDE_OAUTH_OPT_IN}\n`
  );
}
