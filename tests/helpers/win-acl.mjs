// #1167 Lane A — Windows ACL test helper (contract: controller DECISIONS-2 "Test helper contract").
// Consumed by lanes B, C and D. Every function is win32-only and throws on POSIX; every function
// throws an Error on tool failure. `grant`, `setOwner`, `daclText` and `treeDacl` drive icacls
// directly (an independent tamper and an independent oracle); `makePrivate`, `isPrivate` and
// `userSid` use the product primitive bin/lib/win-private-storage.mjs.
// Loading this module has no side effect.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as storage from "../../bin/lib/win-private-storage.mjs";

const win = path.win32;
// Product codes that mean "the environment or a tool failed", not "the item is not private".
const ENVIRONMENT = new Set([
  "unsupported_platform", "system_root_invalid", "tool_missing", "tool_timeout", "tool_failed", "tool_output_invalid",
  "principal_unavailable", "read_failed",
]);

function winOnly(name) {
  if (process.platform !== "win32") throw new Error(`win-acl ${name}() is win32-only`);
}

const arg = (p) => (p.length >= 248 ? path.toNamespacedPath(p) : p);

function icacls(args) {
  const sr = process.env.SystemRoot;
  if (!sr) throw new Error("win-acl: SystemRoot is not set");
  const r = spawnSync(win.join(sr, "System32", "icacls.exe"), args, {
    shell: false, windowsHide: true, timeout: 30_000, encoding: "latin1",
  });
  if (r.error || r.status !== 0) {
    throw new Error(`win-acl: icacls ${args.join(" ")} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${`${r.stdout}${r.stderr}`.trim()}`);
  }
}

function productFailure(name, result) {
  if (ENVIRONMENT.has(result.code)) throw new Error(`win-acl ${name}(): product environment failure ${result.code}`);
}

// `icacls <target> /save <tmp> [/t] /q`, decoded from UTF-16LE into [{name, sddl}] pairs.
function save(target, tree) {
  const dir = mkdtempSync(path.join(tmpdir(), "win-acl-"));
  try {
    const out = path.join(dir, "acl.txt");
    icacls([arg(target), "/save", out, ...(tree ? ["/t"] : []), "/q"]);
    let bytes = readFileSync(out);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) bytes = bytes.subarray(2);
    const lines = bytes.toString("utf16le").split(/\r?\n/).filter((l) => l !== "");
    if (lines.length === 0 || lines.length % 2 !== 0) throw new Error(`win-acl: unexpected icacls /save output for ${target}`);
    const pairs = [];
    for (let i = 0; i < lines.length; i += 2) pairs.push({ name: lines[i], sddl: lines[i + 1] });
    return pairs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dPart(sddl) {
  const m = /D:[^()]*(?:\([^()]*\))*/.exec(sddl);
  if (!m) throw new Error(`win-acl: no D: part in ${sddl}`);
  return m[0];
}

function parseD(text) {
  const m = /^D:((?:P|AI|AR|NO_ACCESS_CONTROL)*)((?:\([^()]*\))*)$/.exec(text);
  if (!m) return null;
  const aces = [...m[2].matchAll(/\(([^()]*)\)/g)].map((a) => a[1].split(";"));
  return { protected: m[1].replace(/NO_ACCESS_CONTROL/g, "").includes("P"), aces };
}

const flagSet = (flags) => new Set(flags.match(/../g) ?? []);

function trusteeIsUser(trustee, sid) {
  if (trustee === sid) return true;
  // R8: a RID-500/501 account renders as LA/LG.
  if (trustee === "LA") return sid.endsWith("-500");
  if (trustee === "LG") return sid.endsWith("-501");
  return false;
}

/** The current user SID string from the product currentPrincipal(). */
export function userSid() {
  winOnly("userSid");
  const who = storage.currentPrincipal();
  if (who.status !== "ok") throw new Error(`win-acl userSid(): currentPrincipal failed: ${who.code}`);
  return who.userSid;
}

/**
 * Directory: product setPrivate(path,'directory'), then asserts verify. File: no Set (R2); asserts
 * its parent directory verifies private and the file verifies private in the same batch.
 */
export function makePrivate(p) {
  winOnly("makePrivate");
  const st = lstatSync(p);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    const set = storage.setPrivate(p, "directory");
    if (set.status !== "ok") throw new Error(`win-acl makePrivate(): setPrivate failed: ${set.code}${set.exitCode === undefined ? "" : ` exit ${set.exitCode}`}`);
    const [v] = storage.verify([{ path: p, kind: "directory", want: "private" }]);
    if (!v.ok) throw new Error(`win-acl makePrivate(): directory does not verify private: ${v.code}`);
    return;
  }
  const [parent, file] = storage.verify([
    { path: win.dirname(p), kind: "directory", want: "private" },
    { path: p, kind: "file", want: "private" },
  ]);
  if (!parent.ok) throw new Error(`win-acl makePrivate(): the file's parent directory is not private: ${parent.code}`);
  if (!file.ok) throw new Error(`win-acl makePrivate(): file does not verify private: ${file.code}`);
}

/** Raw `icacls <path> /grant <spec> /q` (e.g. '*S-1-1-0:(RX)'), an independent tamper. */
export function grant(p, spec) {
  winOnly("grant");
  icacls([arg(p), "/grant", spec, "/q"]);
}

/** Raw `icacls <path> /setowner <sidSpec> /q`. */
export function setOwner(p, sidSpec) {
  winOnly("setOwner");
  icacls([arg(p), "/setowner", sidSpec, "/q"]);
}

/** Independent oracle: the `D:` SDDL text from `icacls <path> /save <tmp> /q`. */
export function daclText(p) {
  winOnly("daclText");
  const pairs = save(p, false);
  if (pairs.length !== 1) throw new Error(`win-acl daclText(): expected one /save entry, got ${pairs.length}`);
  return dPart(pairs[0].sddl);
}

/** `Map<relative path, D: text>` from one `icacls <dir> /save <tmp> /t /q`; the directory itself is ''. */
export function treeDacl(dir) {
  winOnly("treeDacl");
  const base = win.resolve(dir);
  const map = new Map();
  for (const { name, sddl } of save(dir, true)) {
    const plain = name.startsWith("\\\\?\\") ? name.slice(4) : name;
    // /save names are relative to the parent of the saved directory; accept absolute names too.
    const full = /^[A-Za-z]:\\/.test(plain) ? plain : win.join(win.dirname(base), plain);
    map.set(win.relative(base, full), dPart(sddl));
  }
  return map;
}

/**
 * Product verify says private AND the oracle agrees. Directory: `D:P` with exactly the ACE
 * `(A;OICI;FA;;;<sid>)`. File: at least one ACE, every ACE an allow ACE for the user whose only
 * flag may be ID (inherited).
 */
export function isPrivate(p) {
  winOnly("isPrivate");
  const sid = userSid();
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return false;
  const directory = st.isDirectory();
  const results = directory
    ? storage.verify([{ path: p, kind: "directory", want: "private" }])
    : storage.verify([{ path: win.dirname(p), kind: "directory", want: "private" }, { path: p, kind: "file", want: "private" }]);
  const own = results[results.length - 1];
  if (!own.ok) {
    productFailure("isPrivate", own);
    return false;
  }
  const d = parseD(daclText(p));
  if (!d) return false;
  if (directory) {
    if (!d.protected || d.aces.length !== 1) return false;
    const [type, flags, rights, , , trustee] = d.aces[0];
    const f = flagSet(flags);
    return type === "A" && f.size === 2 && f.has("OI") && f.has("CI") && rights === "FA" && trusteeIsUser(trustee, sid);
  }
  return d.aces.length > 0 && d.aces.every(([type, flags, , , , trustee]) =>
    type === "A" && [...flagSet(flags)].every((x) => x === "ID") && trusteeIsUser(trustee, sid));
}
