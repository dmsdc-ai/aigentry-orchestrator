import * as fs from "node:fs";
import * as path from "node:path";
import { winPrivateStorage } from "./private-storage.js";
import type { VerifyItem, VerifyResult, WinPrivateStorage } from "./private-storage.js";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strictJson, uuid } from "../environment/contract.js";
import { controllerContext, currentConfig, inspectGrants, type ControllerContext } from "../environment/grants.js";
import { durableWriteExclusive, fsyncDirectory, readBounded, withWriterLock } from "../environment/storage.js";
import { OwnedInput } from "../environment/owned-input.js";
import { assertExecutableIdentity } from "./worker-sandbox.js";
import { validateExecutableBinding, type ExecutableBinding } from "./model-decision.js";
import { captureManagedRuntime } from "../environment/helper-env.js";

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

/**
 * Explicit nonempty env wins (invalid input refuses). Otherwise reread the fixed
 * controller-owned store on every call; only an absent safe path is unconfigured.
 * The source path never leaves this selector or enters a worker manifest.
 */
export function selectedClaudeOAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[CLAUDE_OAUTH_OPT_IN];
  if (v !== undefined && v !== "") {
    if (!valid(v)) throw new Error("CLAUDE_OAUTH_TOKEN_INVALID");
    return v;
  }
  try {
    const home = os.homedir();
    if (!literalPath(home)) throw new Error();
    const aigentry = path.join(home, ".aigentry");
    const credentials = path.join(aigentry, "credentials");
    const dir = path.join(credentials, "claude-worker");
    for (const parent of [home, aigentry, credentials, dir]) {
      let st: fs.Stats;
      try { st = fs.lstatSync(parent); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" && parent !== home) return undefined;
        throw e;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error();
      const privateDir = parent === credentials || parent === dir;
      if (process.platform === "win32") {
        if (!winPrivateStorage) throw new Error();
        verifyWinPrivate(winPrivateStorage, [{ path: parent, kind: "directory", want: privateDir ? "private" : "owned" }],
          "CLAUDE_OAUTH_STORE_INVALID");
      } else if (st.uid !== euid() || (st.mode & (privateDir ? 0o077 : 0o022)) !== 0) {
        throw new Error();
      }
    }
    const file = path.join(dir, CLAUDE_OAUTH_FILE);
    try { fs.lstatSync(file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    return readClaudeOAuthHandoff(file, file);
  } catch {
    throw new Error("CLAUDE_OAUTH_STORE_INVALID");
  }
}

export type ClaudeAcquisitionKind = "explicit" | "store" | "absent";
export function acquireClaudeOAuthInput(env: NodeJS.ProcessEnv = process.env): {
  input?: OwnedInput; kind: ClaudeAcquisitionKind;
} {
  let selected = selectedClaudeOAuthToken(env);
  if (selected === undefined) return { kind: "absent" };
  const bytes = Buffer.from(selected, "utf8");
  selected = undefined;
  try { return { input: OwnedInput.fromBytes(bytes), kind: env[CLAUDE_OAUTH_OPT_IN] ? "explicit" : "store" }; }
  finally { bytes.fill(0); }
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

export interface ExplicitReceiptRef { readonly receipt: string; readonly attempt: string; readonly authorityGeneration: number }
const safeSid = (sid: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sid);
const receiptDir = (ctx: ControllerContext, sid: string, attempt: string): string =>
  path.join(ctx.home, "sessions", sid, "explicit-handoffs", attempt);
const currentPointer = (ctx: ControllerContext, sid: string): string => path.join(ctx.home, "sessions", sid, "explicit-current.json");
function boundedClock(): { now: number; uptime: number; bootEstimateEpochMs: number } {
  try {
    const now = Date.now(), rawUptime = os.uptime(), uptime = Math.floor(rawUptime * 1000);
    const bootEstimateEpochMs = now - uptime;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(rawUptime) || rawUptime < 0 ||
        !Number.isSafeInteger(uptime) || uptime < 0 || !Number.isSafeInteger(bootEstimateEpochMs) ||
        bootEstimateEpochMs < 0 || !Number.isSafeInteger(now + 300_000)) throw new Error();
    return { now, uptime, bootEstimateEpochMs };
  } catch { throw new Error("ENV_GRANT_CLOCK_UNCERTAIN"); }
}
function checkExpiry(receipt: Record<string, unknown>): number {
  const c = receipt.clock as { issuedUptimeMs?: unknown; bootEstimateEpochMs?: unknown };
  const { now, uptime: up, bootEstimateEpochMs } = boundedClock();
  if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== "bootEstimateEpochMs,issuedUptimeMs" ||
      !Number.isSafeInteger(receipt.issuedAt) || !Number.isSafeInteger(receipt.expiresAt) ||
      !Number.isSafeInteger(c.issuedUptimeMs) || !Number.isSafeInteger(c.bootEstimateEpochMs) ||
      typeof receipt.issuedAt !== "number" || typeof receipt.expiresAt !== "number" ||
      typeof c.issuedUptimeMs !== "number" || typeof c.bootEstimateEpochMs !== "number" ||
      receipt.issuedAt < 0 || receipt.expiresAt < 0 || c.issuedUptimeMs < 0 || c.bootEstimateEpochMs < 0 ||
      receipt.expiresAt - receipt.issuedAt !== 300_000 || now < receipt.issuedAt || up < c.issuedUptimeMs ||
      Math.abs(bootEstimateEpochMs - c.bootEstimateEpochMs) > 1000 ||
      Math.abs(now - receipt.issuedAt - (up - c.issuedUptimeMs)) > 1000) throw new Error("ENV_GRANT_CLOCK_UNCERTAIN");
  if (now >= receipt.expiresAt || up - c.issuedUptimeMs >= 300_000) throw new Error("ENV_GRANT_EXPIRED");
  return now;
}
export function prepareExplicitClaudeHandoff(ctx: ControllerContext, input: OwnedInput, options: {
  sid: string; attempt: string; executable: ExecutableBinding; command: string[];
}): ExplicitReceiptRef {
  if (!safeSid(options.sid) || !uuid(options.attempt) || options.executable.cli !== "claude" ||
      options.command[0] !== options.executable.path || options.command.includes("--bare") ||
      options.command.some(a => /[\u0000-\u001f\u007f]/.test(a))) throw new Error("ENV_BINDING_POLICY_REFUSED");
  assertExecutableIdentity(options.executable, options.command[0]);
  let token: Buffer | undefined;
  try {
    return withWriterLock(ctx.home, () => {
      const c = currentConfig(ctx);
      if (inspectGrants(ctx).total >= 1024) throw new Error("ENV_GRANT_STORE_FULL");
      const { now, uptime, bootEstimateEpochMs } = boundedClock();
      const dir = receiptDir(ctx, options.sid, options.attempt), stage = path.dirname(path.dirname(dir));
      const counted = path.join(ctx.home, "environment", "explicit-receipts", options.attempt);
      fs.mkdirSync(path.dirname(counted), { mode: 0o700, recursive: true });
      fs.mkdirSync(counted, { mode: 0o700 }); fsyncDirectory(path.dirname(counted));
      durableWriteExclusive(path.join(counted, "record.json"), JSON.stringify({ version: 1,
        controllerRootId: ctx.rootId, authorityGeneration: c.authorityGeneration,
        sid: options.sid, attempt: options.attempt }) + "\n");
      fs.mkdirSync(dir, { mode: 0o700, recursive: true }); fsyncDirectory(path.dirname(dir));
      token = input.consume();
      if (token.length < 1 || token.length > 4096 || !token.every(b => b >= 33 && b <= 126)) throw new Error("ENV_INPUT_INVALID");
      const payload = path.join(dir, "token");
      durableWriteExclusive(payload, Buffer.concat([token, Buffer.from("\n")]));
      token.fill(0); token = undefined;
      const receipt = { version: 2, consumerId: "claude-explicit-legacy", controllerRootId: ctx.rootId,
        authorityGeneration: c.authorityGeneration, sid: options.sid, attempt: options.attempt,
        executable: options.executable, command: options.command, issuedAt: now, expiresAt: now + 300_000,
        payloadPath: payload, restart: "never", clock: { issuedUptimeMs: uptime, bootEstimateEpochMs } };
      const file = path.join(dir, "receipt.json");
      durableWriteExclusive(file, JSON.stringify(receipt) + "\n");
      const pointer = `${currentPointer(ctx, options.sid)}.${options.attempt}.tmp`;
      durableWriteExclusive(pointer, JSON.stringify({ receipt: file, attempt: options.attempt }) + "\n");
      fs.renameSync(pointer, currentPointer(ctx, options.sid)); fsyncDirectory(stage);
      return { receipt: file, attempt: options.attempt, authorityGeneration: c.authorityGeneration };
    });
  } finally { token?.fill(0); input.dispose(); }
}
export function claimExplicitClaudeHandoff(ctx: ControllerContext, file: string): {
  command: string[]; executable: ExecutableBinding; env: Record<string, string>;
} {
  if (!path.isAbsolute(file) || path.basename(file) !== "receipt.json" || !uuid(path.basename(path.dirname(file)))) {
    throw new Error("ENV_GRANT_INVALID");
  }
  return withWriterLock(ctx.home, () => {
    const c = currentConfig(ctx), attempt = path.basename(path.dirname(file));
    const sid = path.basename(path.dirname(path.dirname(path.dirname(file))));
    if (!safeSid(sid) || file !== path.join(receiptDir(ctx, sid, attempt), "receipt.json")) throw new Error("ENV_GRANT_INVALID");
    const counted = path.join(ctx.home, "environment", "explicit-receipts", attempt);
    for (const parent of [path.dirname(counted), counted]) {
      const st = fs.lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) {
        throw new Error("ENV_GRANT_INVALID");
      }
    }
    const countedRaw = readBounded(path.join(counted, "record.json"));
    if (countedRaw === null || Buffer.byteLength(countedRaw) > 4096) throw new Error("ENV_GRANT_INVALID");
    const protectedRecord = strictJson(countedRaw) as Record<string, unknown>;
    if (!protectedRecord || typeof protectedRecord !== "object" || Array.isArray(protectedRecord) ||
        Object.keys(protectedRecord).sort().join(",") !== "attempt,authorityGeneration,controllerRootId,sid,version" ||
        protectedRecord.version !== 1 || protectedRecord.controllerRootId !== ctx.rootId ||
        protectedRecord.authorityGeneration !== c.authorityGeneration || protectedRecord.sid !== sid ||
        protectedRecord.attempt !== attempt) throw new Error("ENV_GRANT_INVALID");
    const dir = path.dirname(file), spent = path.join(dir, "spent.json");
    if (fs.existsSync(spent)) throw new Error("ENV_GRANT_SPENT");
    if (fs.existsSync(path.join(dir, "terminal.json"))) throw new Error("ENV_GRANT_REVOKED");
    const raw = readBounded(file);
    if (raw === null || Buffer.byteLength(raw) > 16 * 1024) throw new Error("ENV_GRANT_INVALID");
    const r = strictJson(raw) as Record<string, unknown>;
    const keys = ["version", "consumerId", "controllerRootId", "authorityGeneration", "sid", "attempt", "executable",
      "command", "issuedAt", "expiresAt", "payloadPath", "restart", "clock"];
    if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) || r.version !== 2 ||
        r.consumerId !== "claude-explicit-legacy" || r.controllerRootId !== ctx.rootId ||
        r.authorityGeneration !== c.authorityGeneration || r.sid !== sid || r.attempt !== attempt || r.restart !== "never" ||
        r.payloadPath !== path.join(dir, "token") || !Array.isArray(r.command) ||
        !r.command.every(x => typeof x === "string") || !r.executable || typeof r.executable !== "object") throw new Error("ENV_GRANT_INVALID");
    try { validateExecutableBinding(r.executable, "claude"); } catch { throw new Error("ENV_GRANT_INVALID"); }
    const pinRaw = readBounded(currentPointer(ctx, sid));
    if (pinRaw === null || Buffer.byteLength(pinRaw) > 4096) throw new Error("ENV_GRANT_INVALID");
    const pin = strictJson(pinRaw) as { receipt?: unknown; attempt?: unknown };
    if (!pin || typeof pin !== "object" || Object.keys(pin).sort().join(",") !== "attempt,receipt" ||
        pin.receipt !== file || pin.attempt !== attempt) throw new Error("ENV_GRANT_INVALID");
    const executable = r.executable as ExecutableBinding;
    if (executable.cli !== "claude" || r.command[0] !== executable.path || r.command.includes("--bare")) throw new Error("ENV_BINDING_POLICY_REFUSED");
    assertExecutableIdentity(executable, executable.path);
    const claimedAt = checkExpiry(r);
    durableWriteExclusive(spent, JSON.stringify({ version: 1, controllerRootId: ctx.rootId,
      authorityGeneration: c.authorityGeneration, attempt, claimedAt, claimNonce: randomUUID() }) + "\n");
    const token = readClaudeOAuthHandoff(path.join(dir, "token"), path.join(dir, "token"));
    fs.unlinkSync(path.join(dir, "token")); fsyncDirectory(dir);
    return { command: r.command as string[], executable, env: { [CLAUDE_OAUTH_CHILD]: token } };
  });
}

export async function launchExplicitClaudeHandoff(file: string): Promise<number> {
  const attemptDir = path.dirname(file), sid = path.basename(path.dirname(path.dirname(attemptDir)));
  const home = path.dirname(path.join(attemptDir, "..", "..", ".."));
  const ctx = controllerContext(home);
  if (!safeSid(sid)) throw new Error("ENV_GRANT_INVALID");
  const runtime = captureManagedRuntime(process.env, path.join(ctx.home, "environment"));
  try {
    const claimed = claimExplicitClaudeHandoff(ctx, file);
    const childEnv = { HOME: os.userInfo().homedir, PATH: runtime.base.PATH,
      TMPDIR: runtime.temporary, TMP: runtime.temporary, TEMP: runtime.temporary,
      LANG: runtime.base.LANG, LC_ALL: runtime.base.LC_ALL, TERM: runtime.base.TERM,
      ...claimed.env };
    assertExecutableIdentity(claimed.executable, claimed.command[0]!);
    const child = spawn(claimed.command[0]!, claimed.command.slice(1), { stdio: "inherit", env: childEnv, argv0: "claude" });
    process.title = "claude";
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    process.on("SIGINT", forward); process.on("SIGTERM", forward);
    try { return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); }); }
    finally { process.off("SIGINT", forward); process.off("SIGTERM", forward); }
  } finally { fs.rmSync(runtime.temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--launch-explicit") {
  launchExplicitClaudeHandoff(process.argv[3] ?? "").then(code => { process.exitCode = code; })
    .catch(() => { process.stderr.write("ENV_LEGACY_SECRET_RELAUNCH_REFUSED: create a new approved dispatch with current configuration and binding\n"); process.exitCode = 78; });
}
