// Windows private-storage primitive (#1167, PLAN §1 with controller decisions DECISIONS-2).
//
// Plain ESM, Node built-ins only, no build step. bin/ consumers import it by relative path;
// TypeScript consumers go through src/session/private-storage.ts (a win32-only bridge).
//
// Contract (P2): a private DIRECTORY is Set with icacls (reset, protected DACL with exactly one
// allow ACE for the current user SID with (OI)(CI) full control, owner = user) and verified by
// reading owner/control/DACL back with one Windows PowerShell process per batch. A private FILE is
// never Set (Q-FILE = R2): it is created inside a directory that is already private and is
// accepted only when that parent verifies private in the SAME read batch.
//
// Every export is synchronous, never throws for an expected failure and returns frozen values.
// Off win32 every export answers `unsupported_platform` (aclDigest: null; describe: the
// unsupported_platform sentence). Loading this module has no side effect on any platform: the
// principal, the tools and SystemRoot are resolved on first use only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const win = path.win32;

const SID = /^S-1-\d+(-\d+){1,14}$/;
const SID_TOKEN = "S-1-\\d+(?:-\\d+)+";
const ADMINISTRATORS = "S-1-5-32-544";
const SYSTEM = "S-1-5-18";
const HIGH_LABELS = ["S-1-16-12288", "S-1-16-16384", "S-1-16-20480", "S-1-16-28672"];
const SYSTEM_ROOT = /^[A-Za-z]:\\[^\\/:*?"<>|\x00-\x1f]+(\\[^\\/:*?"<>|\x00-\x1f]+)*$/;
const LONG_PATH = 248;
const MAX_BUFFER = 4 * 1024 * 1024;
const TIMEOUT = { whoami: 10_000, icacls: 15_000, powershell: 60_000 };

const SE_DACL_PRESENT = 0x4;
const SE_DACL_PROTECTED = 0x1000;
const OI = 0x1, CI = 0x2, IO = 0x8;
// ADD_FILE, ADD_SUBDIR, WRITE_EA, DELETE_CHILD, WRITE_ATTRIBUTES, DELETE, WRITE_DAC, WRITE_OWNER,
// MAXIMUM_ALLOWED, GENERIC_ALL, GENERIC_WRITE.
const WRITE_CLASS = 0x520d0156;

// PLAN §1.4 SCRIPT: single line, ASCII, no `"` and no `\`, and no cmdlet. Edits against the PLAN text:
// 1. No cmdlet: objects are built with the .NET `[Type]::new(...)` constructors, not `New-Object`.
//    A cmdlet makes PowerShell run command discovery and module autoload, which in the constructed
//    environment below has no usable module-analysis cache: on windows-latest (#1167) the New-Object
//    script took p50=12933ms per process (first New-Object alone p50=12141ms; readSecurity
//    p50=12185ms), this script p50=216ms (readSecurity p50=183ms), same environment, same output.
//    Any future edit MUST keep the script free of cmdlets and of `"` and `\`.
// 2. The catch reports the innermost exception, because PowerShell wraps constructor exceptions in
//    MethodInvocationException and the PLAN's `$_.Exception.GetType().Name` would never name
//    FileNotFoundException / UnauthorizedAccessException.
const SCRIPT = "foreach($l in [Console]::In.ReadToEnd().Split([char]10)){$t=$l.Trim().Split(' ');if($t.Length -ne 3){continue};try{$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($t[2]));$c=[System.Security.AccessControl.AccessControlSections]'Owner,Access';if($t[1] -eq 'd'){$s=[System.Security.AccessControl.DirectorySecurity]::new($p,$c)}else{$s=[System.Security.AccessControl.FileSecurity]::new($p,$c)};$r=[System.Security.AccessControl.RawSecurityDescriptor]::new($s.GetSecurityDescriptorBinaryForm(),0);$w=$t[0]+' ok '+$r.Owner.Value+' '+[int]$r.ControlFlags;$a=$r.DiscretionaryAcl;if($a -eq $null){$w+=' null'}else{foreach($e in $a){if($e -is [System.Security.AccessControl.KnownAce]){$w+=' '+[int]$e.AceType+':'+[int]$e.AceFlags+':'+$e.AccessMask+':'+$e.SecurityIdentifier.Value}else{$w+=' '+[int]$e.AceType+':'+[int]$e.AceFlags+':x:x'}}};[Console]::Out.WriteLine($w)}catch{$x=$_.Exception;while($null -ne $x.InnerException){$x=$x.InnerException};[Console]::Out.WriteLine($t[0]+' err '+$x.GetType().Name+' '+$x.HResult)}}";

const OK_LINE = new RegExp(`^(\\d+) ok (${SID_TOKEN}) (\\d+)((?: \\S+)*)$`);
const ERR_LINE = /^(\d+) err ([A-Za-z_][A-Za-z0-9_.`]*) (-?\d+)$/;
const ACE_TOKEN = new RegExp(`^(\\d+):(\\d+):(-?\\d+|x):(${SID_TOKEN}|x)$`);

const DESCRIPTIONS = Object.freeze({
  ok: "The operation succeeded.",
  unsupported_platform: "Windows private storage is only available on win32.",
  system_root_invalid: "The SystemRoot environment variable is missing or does not name a plain local directory.",
  tool_missing: "A required Windows system tool is missing or is not a regular file.",
  tool_timeout: "A Windows system tool did not finish within its time limit.",
  tool_failed: "A Windows system tool reported a failure.",
  tool_output_invalid: "A Windows system tool produced output that does not match the expected grammar.",
  principal_unavailable: "The current user security identifier could not be determined.",
  path_invalid: "The path or kind is not acceptable for private storage.",
  missing: "The item does not exist.",
  access_denied: "Access to the item's security information was denied.",
  read_failed: "The item's security information could not be read.",
  identity_changed: "The item was replaced while it was being processed.",
  reparse_point: "The item is a symbolic link, junction or other reparse point.",
  not_directory: "The item is not a directory.",
  not_file: "The item is not a regular file.",
  owner_mismatch: "The item is not owned by the current user.",
  dacl_absent: "The item has no access control list.",
  dacl_null: "The item has a null access control list that grants everyone full access.",
  dacl_not_protected: "The item's access control list is not protected, or its parent directory is not verified private.",
  ace_unsupported: "The item's access control list contains an unsupported entry type.",
  ace_foreign_allow: "The item's access control list grants access to another principal.",
  ace_deny_user: "The item's access control list denies access to the current user.",
  owner_ace_missing: "The item's access control list does not grant the current user inheritable access.",
  ace_foreign_write: "The item's access control list lets another principal modify it.",
});

const freeze = (value) => Object.freeze(value);
const error = (code, extra) => freeze({ status: "error", code, ...extra });
const refuse = (code, extra) => freeze({ ok: false, code, ...extra });
const ACCEPT = freeze({ ok: true });
const STATUS_OK = freeze({ status: "ok" });
const UNSUPPORTED = error("unsupported_platform");
const UNSUPPORTED_CHECK = refuse("unsupported_platform");
const KINDS = new Set(["directory", "file"]);
const WANTS = new Set(["private", "owned", "owner"]);

// Absolute drive-letter path in normal form (no trailing separator, `.`/`..`, `/` or NUL).
function validPath(p) {
  return typeof p === "string" && p.length > 0 && !p.includes("\0") && /^[A-Za-z]:\\/.test(p) && win.resolve(p) === p;
}

// Untrusted paths reach the tools only as one argv element (icacls) or base64 on stdin (PowerShell).
const toolPath = (p) => (p.length >= LONG_PATH ? path.toNamespacedPath(p) : p);

function lstatCode(err) {
  if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return "missing";
  if (err && (err.code === "EACCES" || err.code === "EPERM")) return "access_denied";
  return "read_failed";
}

// Facts kept by Node (PLAN §1.5): type, reparse point (libuv reports symlinks, junctions and
// AppExecLinks as symbolic links), dev = volume serial, ino = 64-bit file index (decimal strings).
function identify(p, kind) {
  let st;
  try { st = lstatSync(p, { bigint: true }); } catch (err) { return { code: lstatCode(err) }; }
  if (st.isSymbolicLink()) return { code: "reparse_point" };
  if (kind === "directory" && !st.isDirectory()) return { code: "not_directory" };
  if (kind === "file" && !st.isFile()) return { code: "not_file" };
  return { dev: String(st.dev), ino: String(st.ino) };
}

function unchanged(p, before) {
  let st;
  try { st = lstatSync(p, { bigint: true }); } catch { return false; }
  return !st.isSymbolicLink() && String(st.dev) === before.dev && String(st.ino) === before.ino;
}

// SystemRoot and the three tools, validated on every call (P1).
function resolveTools() {
  const sr = process.env.SystemRoot;
  if (typeof sr !== "string" || !SYSTEM_ROOT.test(sr) || sr.split("\\").includes("..")) return { code: "system_root_invalid" };
  try {
    const st = lstatSync(sr);
    if (!st.isDirectory() || st.isSymbolicLink()) return { code: "system_root_invalid" };
    if (realpathSync.native(sr).toLowerCase() !== sr.toLowerCase()) return { code: "system_root_invalid" };
  } catch {
    return { code: "system_root_invalid" };
  }
  const tools = {
    sr,
    icacls: win.join(sr, "System32", "icacls.exe"),
    whoami: win.join(sr, "System32", "whoami.exe"),
    powershell: win.join(sr, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  };
  for (const exe of [tools.icacls, tools.whoami, tools.powershell]) {
    try {
      const st = lstatSync(exe);
      if (!st.isFile() || st.isSymbolicLink()) return { code: "tool_missing" };
    } catch {
      return { code: "tool_missing" };
    }
  }
  return tools;
}

// The environment is constructed, never inherited (blocks module and profile hijack).
function toolEnv(tools, powershell) {
  const env = { SystemRoot: tools.sr, WINDIR: tools.sr };
  if (powershell) {
    env.PSModulePath = win.join(tools.sr, "System32", "WindowsPowerShell", "v1.0", "Modules");
    for (const key of ["TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE"]) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
  }
  return env;
}

// Fail closed: expiry kills the child (spawnSync) and returns tool_timeout; output is never parsed on failure.
function run(tools, exe, argv, timeout, input) {
  const r = spawnSync(exe, argv, {
    shell: false, windowsHide: true, timeout, maxBuffer: MAX_BUFFER, encoding: "latin1",
    env: toolEnv(tools, exe === tools.powershell), ...(input === undefined ? {} : { input }),
  });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") return { code: "tool_timeout" };
    if (r.error.code === "ENOENT") return { code: "tool_missing" };
    if (r.error.code === "ENOBUFS") return { code: "tool_output_invalid" };
    return { code: "tool_failed", exitCode: null };
  }
  if (r.status !== 0) return { code: "tool_failed", exitCode: r.status };
  return { stdout: r.stdout };
}

let principal = null;

function readPrincipal() {
  const tools = resolveTools();
  if (tools.code) return error(tools.code);
  const user = run(tools, tools.whoami, ["/user", "/fo", "csv", "/nh"], TIMEOUT.whoami);
  if (user.code) return error(user.code);
  // The account name column is ignored, so the locale and commas inside quotes do not matter.
  const lines = user.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  const m = lines.length === 1 ? new RegExp(`,"(${SID_TOKEN})"\\s*$`).exec(lines[0]) : null;
  if (!m) return error("tool_output_invalid");
  if (!SID.test(m[1])) return error("principal_unavailable");
  const groups = run(tools, tools.whoami, ["/groups", "/fo", "csv", "/nh"], TIMEOUT.whoami);
  if (groups.code) return error(groups.code);
  const sids = new Set([...groups.stdout.matchAll(new RegExp(`"(${SID_TOKEN})"`, "g"))].map((g) => g[1]));
  if (sids.size === 0) return error("tool_output_invalid");
  // A filtered admin token lists 544 deny-only with a Medium label, so the label decides.
  const elevatedAdmin = sids.has(ADMINISTRATORS) && HIGH_LABELS.some((s) => sids.has(s));
  return freeze({ status: "ok", userSid: m[1], elevatedAdmin });
}

/** `{status:'ok', userSid, elevatedAdmin}` or `{status:'error', code}`. A success is cached for the process. */
export function currentPrincipal() {
  if (!WIN) return UNSUPPORTED;
  if (principal) return principal;
  const result = readPrincipal();
  if (result.status === "ok") principal = result;
  return result;
}

/**
 * Applies the P2 Set state to a DIRECTORY. Precondition: the caller created it in this call and
 * it is not a reparse point (asserted by lstat; any (dev, ino) change across the tool runs returns
 * `identity_changed`). Never verifies. Kind 'file' is refused `path_invalid` (Q-FILE = R2).
 */
export function setPrivate(p, kind) {
  if (!WIN) return UNSUPPORTED;
  if (kind !== "directory" || !validPath(p)) return error("path_invalid");
  const tools = resolveTools();
  if (tools.code) return error(tools.code);
  const who = currentPrincipal();
  if (who.status !== "ok") return who;
  const before = identify(p, "directory");
  if (before.code) return error(before.code);
  const target = toolPath(p);
  const calls = [
    [target, "/reset", "/q"],
    [target, "/inheritance:r", "/grant:r", `*${who.userSid}:(OI)(CI)F`, "/q"],
    [target, "/setowner", `*${who.userSid}`, "/q"],
  ];
  for (const argv of calls) {
    const r = run(tools, tools.icacls, argv, TIMEOUT.icacls);
    if (r.code) return error(r.code, r.code === "tool_failed" ? { exitCode: r.exitCode } : undefined);
  }
  if (!unchanged(p, before)) return error("identity_changed");
  return STATUS_OK;
}

function errCode(typeName) {
  if (typeName === "FileNotFoundException" || typeName === "DirectoryNotFoundException") return "missing";
  if (typeName === "UnauthorizedAccessException" || typeName === "PrivilegeNotHeldException") return "access_denied";
  return "read_failed";
}

// Strict grammar (PLAN §1.4): every line ends in CRLF or LF and there is exactly one line per sent
// index. Anything else invalidates the whole batch (returns null).
function parseBatch(stdout, sent) {
  if (stdout.length > 0 && !stdout.endsWith("\n")) return null;
  const lines = stdout.length === 0 ? [] : stdout.slice(0, -1).split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const out = new Map();
  for (const line of lines) {
    let m = OK_LINE.exec(line), facts;
    if (m) {
      const control = Number(m[3]);
      if (!Number.isSafeInteger(control) || control > 0xffff) return null;
      const tokens = m[4] === "" ? [] : m[4].slice(1).split(" ");
      let dacl = null;
      if (!(tokens.length === 1 && tokens[0] === "null")) {
        dacl = [];
        for (const token of tokens) {
          const a = ACE_TOKEN.exec(token);
          if (!a) return null;
          const type = Number(a[1]), flags = Number(a[2]), mask = a[3] === "x" ? null : Number(a[3]);
          if (type > 0xff || flags > 0xff) return null;
          if (mask !== null && (!Number.isSafeInteger(mask) || mask < -0x80000000 || mask > 0xffffffff)) return null;
          dacl.push(freeze({ type, flags, mask: mask === null ? null : mask >>> 0, sid: a[4] === "x" ? null : a[4] }));
        }
        freeze(dacl);
      }
      facts = { status: "ok", ownerSid: m[2], control, dacl };
    } else if ((m = ERR_LINE.exec(line))) {
      facts = { status: "error", code: errCode(m[2]) };
    } else {
      return null;
    }
    const i = Number(m[1]);
    if (String(i) !== m[1] || !sent.has(i) || out.has(i)) return null;
    out.set(i, facts);
  }
  return out.size === sent.size ? out : null;
}

// One PowerShell process for every item that passed lstat; each item is bracketed by lstat.
function readBatch(tools, items) {
  const ids = items.map((item) =>
    (!item || !KINDS.has(item.kind) || !validPath(item.path) ? { code: "path_invalid" } : identify(item.path, item.kind)));
  const sent = new Map();
  ids.forEach((id, i) => { if (!id.code) sent.set(i, id); });
  let r = null, parsed = null;
  if (sent.size > 0) {
    const input = [...sent.keys()].map((i) =>
      `${i} ${items[i].kind === "directory" ? "d" : "f"} ${Buffer.from(toolPath(items[i].path), "utf8").toString("base64")}\n`).join("");
    r = run(tools, tools.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], TIMEOUT.powershell, input);
    if (!r.code) parsed = parseBatch(r.stdout, sent);
  }
  return items.map((_, i) => {
    const id = ids[i];
    if (id.code) return error(id.code);
    const where = { dev: id.dev, ino: id.ino };
    if (r.code) return error(r.code, where);
    if (!parsed) return error("tool_output_invalid", where);
    if (!unchanged(items[i].path, id)) return error("identity_changed", where);
    return freeze({ ...parsed.get(i), ...where });
  });
}

/**
 * `items` = `[{path, kind}]`. One PowerShell process reads every item. Per item: `{status:'ok',
 * ownerSid, control, dacl: null | [{type, flags, mask, sid}], dev, ino}` or `{status:'error', code,
 * dev?, ino?}`.
 */
export function readSecurity(items) {
  if (!Array.isArray(items)) throw new TypeError("readSecurity(items): items must be an array");
  if (!WIN) return freeze(items.map(() => UNSUPPORTED));
  const tools = resolveTools();
  if (tools.code) return freeze(items.map(() => error(tools.code)));
  return freeze(readBatch(tools, items));
}

const isFacts = (facts) => !!facts && facts.status === "ok" && typeof facts.ownerSid === "string" &&
  Number.isInteger(facts.control) && (facts.dacl === null || Array.isArray(facts.dacl));
const isPrincipal = (who) => !!who && who.status === "ok" && typeof who.userSid === "string" && SID.test(who.userSid);

// Owner is the user, or Administrators when the token is an elevated admin. `adminAlways`: a file
// inside a verified-private directory accepts Administrators regardless of elevation (R2 (d)).
function ownerOk(facts, who, adminAlways) {
  return facts.ownerSid === who.userSid || (facts.ownerSid === ADMINISTRATORS && (adminAlways || who.elevatedAdmin === true));
}

const supportedAces = (dacl) => dacl.every((a) => (a.type === 0 || a.type === 1) && a.mask !== null && a.sid !== null);

/**
 * P2 verify (pure). Directory: DACL present, not null, protected; ACE types allow/deny only; allow
 * trustees == {user}; no deny for the user; an inheritable (OI|CI, not IO) user allow ACE; owner
 * rule. File (R2): `options.parentPrivate === true` is required (else `dacl_not_protected`); the
 * protected clause does not apply (inherited ACEs are fine); allow trustees == {user}; no deny for
 * the user; owner is the user or Administrators.
 */
export function checkPrivate(facts, kind, who, options) {
  if (!WIN) return UNSUPPORTED_CHECK;
  if (facts && facts.status === "error") return refuse(facts.code);
  if (!isFacts(facts) || !KINDS.has(kind)) return refuse("path_invalid");
  if (!isPrincipal(who)) return refuse("principal_unavailable");
  const file = kind === "file";
  if (file && !(options && options.parentPrivate === true)) return refuse("dacl_not_protected");
  if (!(facts.control & SE_DACL_PRESENT)) return refuse("dacl_absent");
  if (facts.dacl === null) return refuse("dacl_null");
  if (!file && !(facts.control & SE_DACL_PROTECTED)) return refuse("dacl_not_protected");
  if (!supportedAces(facts.dacl)) return refuse("ace_unsupported");
  const allow = facts.dacl.filter((a) => a.type === 0);
  if (allow.some((a) => a.sid !== who.userSid)) return refuse("ace_foreign_allow");
  if (allow.length === 0) return refuse("owner_ace_missing");
  if (facts.dacl.some((a) => a.type === 1 && a.sid === who.userSid)) return refuse("ace_deny_user");
  if (!file && !allow.some((a) => (a.flags & (OI | CI)) === (OI | CI) && !(a.flags & IO))) return refuse("owner_ace_missing");
  if (!ownerOk(facts, who, file)) return refuse("owner_mismatch");
  return ACCEPT;
}

/**
 * P-OWNED (pure; D1). Owner rule; DACL present and not null; ACE types allow/deny only; no allow
 * ACE effective on the object (no IO) grants a write-class bit to a trustee outside {user, SYSTEM,
 * Administrators}. CREATOR OWNER / OWNER RIGHTS / TrustedInstaller count as foreign.
 */
export function checkOwned(facts, who) {
  if (!WIN) return UNSUPPORTED_CHECK;
  if (facts && facts.status === "error") return refuse(facts.code);
  if (!isFacts(facts)) return refuse("path_invalid");
  if (!isPrincipal(who)) return refuse("principal_unavailable");
  if (!ownerOk(facts, who, false)) return refuse("owner_mismatch");
  if (!(facts.control & SE_DACL_PRESENT)) return refuse("dacl_absent");
  if (facts.dacl === null) return refuse("dacl_null");
  if (!supportedAces(facts.dacl)) return refuse("ace_unsupported");
  const trusted = new Set([who.userSid, SYSTEM, ADMINISTRATORS]);
  if (facts.dacl.some((a) => a.type === 0 && !(a.flags & IO) && !trusted.has(a.sid) && (a.mask & WRITE_CLASS) !== 0)) {
    return refuse("ace_foreign_write");
  }
  return ACCEPT;
}

/** Owner rule only (pure; pre-existing preservation targets). */
export function checkOwner(facts, who) {
  if (!WIN) return UNSUPPORTED_CHECK;
  if (facts && facts.status === "error") return refuse(facts.code);
  if (!isFacts(facts)) return refuse("path_invalid");
  if (!isPrincipal(who)) return refuse("principal_unavailable");
  return ownerOk(facts, who, false) ? ACCEPT : refuse("owner_mismatch");
}

/** sha256 hex of `owner|control&0x1004|sorted(type:flags&0x1f:mask:sid)` (order-insensitive); null off win32 or for non-facts. */
export function aclDigest(facts) {
  if (!WIN || !isFacts(facts)) return null;
  const aces = facts.dacl === null ? "null"
    : facts.dacl.map((a) => `${a.type}:${a.flags & 0x1f}:${a.mask === null ? "x" : a.mask >>> 0}:${a.sid ?? "x"}`).sort().join(",");
  return createHash("sha256").update(`${facts.ownerSid}|${facts.control & 0x1004}|${aces}`).digest("hex");
}

/**
 * `items` = `[{path, kind, want: 'private'|'owned'|'owner'}]`; one read batch, then the matching
 * check. Per item `{ok, code?, digest?, dev?, ino?}` (dev/ino whenever lstat succeeded; digest when
 * ok). A file with want 'private' requires its parent directory in the same batch and private
 * (R2), otherwise `dacl_not_protected`.
 */
export function verify(items) {
  if (!Array.isArray(items)) throw new TypeError("verify(items): items must be an array");
  if (!WIN) return freeze(items.map(() => UNSUPPORTED_CHECK));
  const tools = resolveTools();
  if (tools.code) return freeze(items.map(() => refuse(tools.code)));
  const who = currentPrincipal();
  if (who.status !== "ok") return freeze(items.map(() => refuse(who.code)));
  const facts = readBatch(tools, items.map((item) => (item && WANTS.has(item.want) ? { path: item.path, kind: item.kind } : null)));
  const privateDirs = new Set();
  items.forEach((item, i) => {
    if (facts[i].status === "ok" && item.kind === "directory" && checkPrivate(facts[i], "directory", who).ok) privateDirs.add(item.path);
  });
  return freeze(items.map((item, i) => {
    const f = facts[i];
    const where = f.dev === undefined ? undefined : { dev: f.dev, ino: f.ino };
    if (f.status !== "ok") return refuse(f.code, where);
    let check;
    if (item.want === "owned") check = checkOwned(f, who);
    else if (item.want === "owner") check = checkOwner(f, who);
    else check = checkPrivate(f, item.kind, who, { parentPrivate: item.kind === "file" && privateDirs.has(win.dirname(item.path)) });
    return check.ok ? freeze({ ok: true, digest: aclDigest(f), ...where }) : refuse(check.code, where);
  }));
}

/**
 * Per-public-call memo (PLAN §1.7). Entries are keyed by path and valid only while lstat
 * (dev, ino) is unchanged; nothing outlives the session object.
 * - require(items) | require(path, want): verify results, reusing valid entries. A pending
 *   directory (markSet after setPrivate) with unchanged identity is accepted unread (private
 *   implies owned and owner). A file read with want 'private' is always batched with its parent
 *   directory (R2 same batch).
 * - markSet(path, kind): record an object the caller just created as pending; a pending file is
 *   never accepted unread, it is verified by the next reader or flush (R2: files get no Set).
 * - flush(): verify every pending object as private in one batch; `{status:'ok'}` or the first error.
 * - digest(path): flush first when the path is pending, then a verify result carrying the digest.
 */
export function createSession() {
  if (!WIN) return UNSUPPORTED;
  const verified = new Map(); // path -> {kind, dev, ino, digest, results: Map<want, result>}
  const pending = new Map(); // path -> {kind, dev, ino}
  const key = (item) => `${item.want}\0${item.path}`;

  const kindOf = (p) => {
    try { return lstatSync(p).isDirectory() ? "directory" : "file"; } catch { return "file"; }
  };

  function remember(item, result) {
    if (result.dev === undefined) return;
    let entry = verified.get(item.path);
    if (!entry || entry.dev !== result.dev || entry.ino !== result.ino || entry.kind !== item.kind) {
      entry = { kind: item.kind, dev: result.dev, ino: result.ino, digest: undefined, results: new Map() };
      verified.set(item.path, entry);
    }
    if (result.ok) entry.digest = result.digest;
    entry.results.set(item.want, result);
  }

  function batch(items) {
    const reads = [];
    const index = new Map();
    const add = (item) => { if (!index.has(key(item))) { index.set(key(item), reads.length); reads.push(item); } };
    for (const item of items) {
      add(item);
      if (item.kind === "file" && item.want === "private") add({ path: win.dirname(item.path), kind: "directory", want: "private" });
    }
    const results = verify(reads);
    reads.forEach((item, i) => {
      remember(item, results[i]);
      const p = pending.get(item.path);
      if (p && item.want === "private" && results[i].ok && results[i].dev === p.dev && results[i].ino === p.ino) pending.delete(item.path);
    });
    return items.map((item) => results[index.get(key(item))]);
  }

  function requireItems(items) {
    const out = new Array(items.length);
    const todo = [];
    items.forEach((item, i) => {
      if (!item || !WANTS.has(item.want) || !KINDS.has(item.kind) || !validPath(item.path)) {
        out[i] = refuse("path_invalid");
        return;
      }
      const id = identify(item.path, item.kind);
      if (id.code) { out[i] = refuse(id.code); return; }
      const entry = verified.get(item.path);
      const hit = entry && entry.dev === id.dev && entry.ino === id.ino && entry.kind === item.kind ? entry.results.get(item.want) : undefined;
      if (hit && hit.ok) { out[i] = hit; return; }
      const p = pending.get(item.path);
      if (p && p.kind === "directory" && item.kind === "directory" && p.dev === id.dev && p.ino === id.ino) {
        out[i] = freeze({ ok: true, dev: id.dev, ino: id.ino });
        return;
      }
      todo.push(i);
    });
    if (todo.length > 0) {
      const results = batch(todo.map((i) => items[i]));
      todo.forEach((i, k) => { out[i] = results[k]; });
    }
    return freeze(out);
  }

  function require(items, want) {
    if (typeof items === "string") return requireItems([{ path: items, kind: kindOf(items), want }])[0];
    if (!Array.isArray(items)) throw new TypeError("require(items): items must be an array or a path");
    return requireItems(items);
  }

  function markSet(p, kind) {
    if (!KINDS.has(kind) || !validPath(p)) return error("path_invalid");
    const id = identify(p, kind);
    if (id.code) return error(id.code);
    verified.delete(p);
    pending.set(p, { kind, dev: id.dev, ino: id.ino });
    return STATUS_OK;
  }

  function flush() {
    if (pending.size === 0) return STATUS_OK;
    const items = [...pending].map(([p, e]) => ({ path: p, kind: e.kind, want: "private" }));
    pending.clear();
    const failed = batch(items).find((r) => !r.ok);
    return failed ? error(failed.code) : STATUS_OK;
  }

  function digest(p) {
    if (pending.has(p)) {
      const f = flush();
      if (f.status !== "ok") return refuse(f.code);
    }
    if (!validPath(p)) return refuse("path_invalid");
    const kind = kindOf(p);
    const id = identify(p, kind);
    if (id.code) return refuse(id.code);
    const entry = verified.get(p);
    if (entry && entry.dev === id.dev && entry.ino === id.ino && entry.kind === kind && entry.digest !== undefined) {
      return freeze({ ok: true, digest: entry.digest, dev: id.dev, ino: id.ino });
    }
    return batch([{ path: p, kind, want: "owner" }])[0];
  }

  return freeze({ status: "ok", require, markSet, flush, digest });
}

/** Fixed English sentence for a code; never contains a path, SID or tool text. */
export function describe(code) {
  if (!WIN) return DESCRIPTIONS.unsupported_platform;
  return Object.hasOwn(DESCRIPTIONS, code) ? DESCRIPTIONS[code] : "Windows private storage failed for an unknown reason.";
}
