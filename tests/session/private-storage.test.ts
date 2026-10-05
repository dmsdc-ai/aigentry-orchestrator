// #1167 Lane A — the Windows private-storage primitive (bin/lib/win-private-storage.mjs), its typed
// bridge (src/session/private-storage.ts) and the shared test helper (tests/helpers/win-acl.mjs).
//
// Every platform: the export set is exactly PLAN §1.2 and loading the module, the helper or the
// bridge has no side effect (no process, no filesystem mutation, no probe outside the repo, no env change).
// POSIX: every export answers unsupported_platform, the bridge is null and the helper throws.
// win32: real icacls / whoami / PowerShell round trips. These cases double as the PLAN §6 design
// probes R1 (PowerShell read-back), R2 (icacls Set shape), R3 (elevation), R4 (latency, diagnostic
// only), R5 (long and Unicode paths) and R9 (libuv reparse/nlink/ino facts); every failure message
// starts with the probe it falsifies. Cases are registered per platform, so neither platform skips.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { winPrivateStorage } from "../../src/session/private-storage.js";
import type { Ace, Principal, SecurityFacts, VerifyItem, WinPrivateStorage } from "../../src/session/private-storage.js";

interface WinAcl {
  makePrivate(path: string): void;
  grant(path: string, spec: string): void;
  setOwner(path: string, sidSpec: string): void;
  daclText(path: string): string;
  treeDacl(dir: string): Map<string, string>;
  isPrivate(path: string): boolean;
  userSid(): string;
}

const WIN = process.platform === "win32";
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const MODULE = join(REPO, "bin", "lib", "win-private-storage.mjs");
const HELPER = join(REPO, "tests", "helpers", "win-acl.mjs");
const BRIDGE = join(REPO, "dist", "src", "session", "private-storage.js");
const mod = (await import(pathToFileURL(MODULE).href)) as WinPrivateStorage;
const acl = (await import(pathToFileURL(HELPER).href)) as WinAcl;

const EXPORTS = ["aclDigest", "checkOwned", "checkOwner", "checkPrivate", "createSession", "currentPrincipal", "describe",
  "readSecurity", "setPrivate", "verify"];
const HELPER_EXPORTS = ["daclText", "grant", "isPrivate", "makePrivate", "setOwner", "treeDacl", "userSid"];
const CODES = ["ok", "unsupported_platform", "system_root_invalid", "tool_missing", "tool_timeout", "tool_failed",
  "tool_output_invalid", "principal_unavailable", "path_invalid", "missing", "access_denied", "read_failed", "identity_changed",
  "reparse_point", "not_directory", "not_file", "owner_mismatch", "dacl_absent", "dacl_null", "dacl_not_protected",
  "ace_unsupported", "ace_foreign_allow", "ace_deny_user", "owner_ace_missing", "ace_foreign_write"] as const;

const USER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const FULL = 0x1f01ff;
// Facts and a principal that satisfy every predicate on win32 (used to prove the POSIX gate and as
// the base of the synthetic predicate cases).
const goodFacts = (over: Partial<SecurityFacts> = {}): SecurityFacts =>
  ({ status: "ok", ownerSid: USER, control: 0x9404, dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }], dev: "1", ino: "2", ...over });
const goodWho = (over: Partial<Principal> = {}): Principal => ({ status: "ok", userSid: USER, elevatedAdmin: false, ...over });

test("the module exports exactly the PLAN §1.2 API and the helper exactly the DECISIONS-2 contract", () => {
  assert.deepEqual(Object.keys(mod).sort(), EXPORTS);
  for (const name of EXPORTS) assert.equal(typeof (mod as unknown as Record<string, unknown>)[name], "function", name);
  assert.deepEqual(Object.keys(acl).sort(), HELPER_EXPORTS);
});

test("loading the module, the helper and the bridge has no side effect", () => {
  const probe = `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [repo, ...urls] = JSON.parse(process.argv[1]);
const inside = (p) => { const s = String(p instanceof URL ? p.pathname : p); return process.platform === "win32" ? s.toLowerCase().startsWith(repo.toLowerCase()) : s.startsWith(repo); };
const calls = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const orig = cp[name]; cp[name] = function (...a) { calls.push("child_process." + name); return orig.apply(this, a); };
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync",
  "chmodSync", "chownSync", "symlinkSync", "linkSync", "copyFileSync", "cpSync", "utimesSync"]) {
  const orig = fs[name]; fs[name] = function (...a) { calls.push("fs." + name + " " + String(a[0])); return orig.apply(this, a); };
}
for (const name of ["lstatSync", "statSync", "realpathSync", "existsSync", "readFileSync", "accessSync"]) {
  const orig = fs[name];
  const wrapped = function (...a) { if (!inside(a[0])) calls.push("fs." + name + " " + String(a[0])); return orig.apply(this, a); };
  if (orig.native) wrapped.native = function (...a) { if (!inside(a[0])) calls.push("fs." + name + ".native " + String(a[0])); return orig.native.apply(this, a); };
  fs[name] = wrapped;
}
syncBuiltinESMExports();
const env = JSON.stringify(process.env), cwd = process.cwd();
const keys = [];
for (const u of urls) keys.push(Object.keys(await import(u)).length);
process.stdout.write(JSON.stringify({ calls, envSame: JSON.stringify(process.env) === env, cwdSame: process.cwd() === cwd, keys }));
`;
  const args = [REPO, pathToFileURL(MODULE).href, pathToFileURL(HELPER).href, pathToFileURL(BRIDGE).href];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe, JSON.stringify(args)], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `probe child failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { calls: string[]; envSame: boolean; cwdSame: boolean; keys: number[] };
  assert.deepEqual(out.calls, [], "importing must not spawn, mutate the filesystem or probe outside the repo");
  assert.ok(out.envSame && out.cwdSame, "importing must not change process.env or the cwd");
  assert.deepEqual(out.keys.slice(0, 2), [EXPORTS.length, HELPER_EXPORTS.length]);
});

if (!WIN) {
  test("POSIX: every export answers unsupported_platform and the bridge is null", () => {
    assert.equal(winPrivateStorage, null);
    const unsupported = { status: "error", code: "unsupported_platform" };
    const refused = { ok: false, code: "unsupported_platform" };
    const dir = mkdtempSync(join(tmpdir(), "ps1167-posix-"));
    try {
      const before = statSync(dir).mode;
      const checks: unknown[] = [
        mod.currentPrincipal(), mod.setPrivate(dir, "directory"), mod.setPrivate(join(dir, "f"), "file"), mod.createSession(),
      ];
      for (const r of checks) {
        assert.deepEqual(r, unsupported);
        assert.ok(Object.isFrozen(r));
      }
      const read = mod.readSecurity([{ path: dir, kind: "directory" }, { path: join(dir, "x"), kind: "file" }]);
      assert.deepEqual(read, [unsupported, unsupported]);
      assert.ok(Object.isFrozen(read));
      const items: VerifyItem[] = [{ path: dir, kind: "directory", want: "private" }, { path: dir, kind: "directory", want: "owned" }];
      assert.deepEqual(mod.verify(items), [refused, refused]);
      // Inputs that pass every predicate on win32 still refuse: the gate is the platform.
      assert.deepEqual(mod.checkPrivate(goodFacts(), "directory", goodWho()), refused);
      assert.deepEqual(mod.checkPrivate(goodFacts(), "file", goodWho(), { parentPrivate: true }), refused);
      assert.deepEqual(mod.checkOwned(goodFacts(), goodWho()), refused);
      assert.deepEqual(mod.checkOwner(goodFacts(), goodWho()), refused);
      assert.equal(mod.aclDigest(goodFacts()), null);
      assert.equal(mod.describe("ok"), mod.describe("unsupported_platform"));
      assert.match(mod.describe("unsupported_platform"), /win32/);
      assert.equal(statSync(dir).mode, before, "setPrivate must not touch the directory off win32");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POSIX: every helper function throws (win32-only contract)", () => {
    const calls: Array<() => unknown> = [
      () => acl.makePrivate(tmpdir()), () => acl.grant(tmpdir(), "*S-1-1-0:(R)"), () => acl.setOwner(tmpdir(), "*S-1-5-32-544"),
      () => acl.daclText(tmpdir()), () => acl.treeDacl(tmpdir()), () => acl.isPrivate(tmpdir()), () => acl.userSid(),
    ];
    for (const call of calls) assert.throws(call, /win32-only/);
  });
}

if (WIN) {
  const SR = process.env.SystemRoot ?? "";
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ps1167-")));
  const cleanup: Array<() => void> = [];
  after(() => {
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort; rmSync below reports */ } }
    rmSync(base, { recursive: true, force: true });
  });
  const P = (probe: string, msg: string): string => `[probe ${probe}] ${msg}`;
  const icacls = (args: string[]): void => {
    const r = spawnSync(join(SR, "System32", "icacls.exe"), args, { shell: false, windowsHide: true, timeout: 30_000, encoding: "latin1" });
    assert.equal(r.status, 0, `raw icacls ${args.join(" ")} failed: ${r.error?.message ?? ""} ${r.stdout}${r.stderr}`);
  };
  const principal = (): Principal => {
    const who = mod.currentPrincipal();
    assert.equal(who.status, "ok", P("R1", `currentPrincipal failed: ${JSON.stringify(who)}`));
    return who as Principal;
  };
  const privDir = (name: string, probe = "R2"): string => {
    const dir = join(base, name);
    mkdirSync(dir);
    assert.deepEqual(mod.setPrivate(dir, "directory"), { status: "ok" }, P(probe, `setPrivate(${name}) failed`));
    return dir;
  };
  const one = (item: VerifyItem) => mod.verify([item])[0]!;
  const facts = (path: string, kind: "directory" | "file"): SecurityFacts => {
    const f = mod.readSecurity([{ path, kind }])[0]!;
    assert.equal(f.status, "ok", P("R1", `readSecurity(${path}) failed: ${JSON.stringify(f)}`));
    return f as SecurityFacts;
  };
  const sidPattern = (sid: string): string => (sid.endsWith("-500") ? `(?:${sid}|LA)` : sid);

  test("win32 R3: currentPrincipal reads the user SID and the elevation from whoami", (t) => {
    const who = principal();
    assert.match(who.userSid, /^S-1-\d+(-\d+){1,14}$/, P("R3", "user SID shape"));
    assert.equal(typeof who.elevatedAdmin, "boolean");
    assert.ok(Object.isFrozen(who));
    assert.equal(mod.currentPrincipal(), who, "the principal is computed once per process");
    assert.equal(acl.userSid(), who.userSid);
    t.diagnostic(`[probe R3] elevatedAdmin=${who.elevatedAdmin} userRid=${who.userSid.split("-").pop()}`);
  });

  test("win32 R1/R2: setPrivate then readSecurity shows a protected single-ACE DACL owned by the user", () => {
    const who = principal();
    const dir = privDir("set");
    const read = mod.readSecurity([{ path: dir, kind: "directory" }, { path: join(base, "absent"), kind: "directory" }]);
    assert.ok(Object.isFrozen(read) && Object.isFrozen(read[0]));
    const f = read[0] as SecurityFacts;
    assert.equal(f.status, "ok", P("R1", `PowerShell read-back failed: ${JSON.stringify(f)}`));
    assert.equal(f.ownerSid, who.userSid, P("R2", "owner after /setowner"));
    assert.equal(f.control & 0x1004, 0x1004, P("R2", `control ${f.control} lacks DACL_PRESENT|DACL_PROTECTED`));
    assert.deepEqual(f.dacl, [{ type: 0, flags: 3, mask: FULL, sid: who.userSid }], P("R2", "exactly one (OI)(CI) full-control allow ACE"));
    const st = lstatSync(dir, { bigint: true });
    assert.deepEqual([f.dev, f.ino], [String(st.dev), String(st.ino)]);
    assert.deepEqual(read[1], { status: "error", code: "missing" });
    const v = one({ path: dir, kind: "directory", want: "private" });
    assert.equal(v.ok, true, P("R1", `verify private: ${JSON.stringify(v)}`));
    assert.match(v.digest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(v.digest, mod.aclDigest(f));
    assert.deepEqual(mod.checkOwned(f, who), { ok: true });
    assert.deepEqual(mod.checkOwner(f, who), { ok: true });
  });

  test("win32 R2: the independent icacls /save oracle agrees with the product read-back", () => {
    const who = principal();
    const dir = privDir("oracle");
    const file = join(dir, "inner.txt");
    writeFileSync(file, "x");
    const sid = sidPattern(who.userSid);
    const d = acl.daclText(dir);
    assert.match(d, new RegExp(`^D:P(?:AI|AR)*\\(A;OICI;FA;;;${sid}\\)$`), P("R2", `oracle D: text ${d}`));
    assert.match(acl.daclText(file), new RegExp(`^D:(?:AI|AR)*\\(A;ID;FA;;;${sid}\\)$`), P("R2", "file inherits the single ACE"));
    const tree = acl.treeDacl(dir);
    assert.deepEqual([...tree.keys()].sort(), ["", "inner.txt"], P("R2", `treeDacl keys ${JSON.stringify([...tree.keys()])}`));
    assert.equal(tree.get(""), d);
    assert.equal(tree.get("inner.txt"), acl.daclText(file));
    assert.equal(acl.isPrivate(dir), true, P("R2", "isPrivate(directory)"));
    assert.equal(acl.isPrivate(file), true, P("R2", "isPrivate(file)"));
    acl.makePrivate(file);
  });

  test("win32 R2: an Everyone ACE added with icacls is refused ace_foreign_allow", () => {
    const dir = privDir("tamper");
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    acl.grant(file, "*S-1-1-0:(R)");
    const [dv, fv] = mod.verify([{ path: dir, kind: "directory", want: "private" }, { path: file, kind: "file", want: "private" }]);
    assert.equal(dv!.ok, true);
    assert.equal(fv!.code, "ace_foreign_allow", P("R2", `tampered file: ${JSON.stringify(fv)}`));
    acl.grant(dir, "*S-1-1-0:(R)");
    assert.equal(one({ path: dir, kind: "directory", want: "private" }).code, "ace_foreign_allow", P("R2", "tampered directory"));
    assert.match(acl.daclText(dir), /\(A;;FR;;;WD\)/);
    assert.equal(acl.isPrivate(dir), false);
    // Everyone:(R) carries no write-class bit, so the directory is still P-OWNED.
    assert.equal(one({ path: dir, kind: "directory", want: "owned" }).ok, true);
  });

  test("win32 R9: junctions and symbolic links are reparse points, never followed", () => {
    const target = privDir("jtarget", "R9");
    const junction = join(base, "junction");
    symlinkSync(target, junction, "junction");
    cleanup.push(() => unlinkSync(junction));
    assert.equal(lstatSync(junction).isSymbolicLink(), true, P("R9", "libuv reports a junction as a symbolic link"));
    assert.equal(one({ path: junction, kind: "directory", want: "private" }).code, "reparse_point", P("R9", "verify(junction)"));
    assert.deepEqual(mod.setPrivate(junction, "directory"), { status: "error", code: "reparse_point" }, P("R9", "setPrivate(junction)"));
    assert.deepEqual(mod.readSecurity([{ path: junction, kind: "directory" }]), [{ status: "error", code: "reparse_point" }]);
    assert.equal(one({ path: target, kind: "directory", want: "private" }).ok, true, "the target is untouched");
    const dirLink = join(base, "dirlink");
    try {
      symlinkSync(target, dirLink, "dir");
    } catch (e) {
      assert.fail(P("R9", `creating a directory symlink needs SeCreateSymbolicLinkPrivilege (elevated or Developer Mode): ${(e as Error).message}`));
    }
    cleanup.push(() => unlinkSync(dirLink));
    assert.equal(lstatSync(dirLink).isSymbolicLink(), true, P("R9", "directory symlink"));
    assert.equal(one({ path: dirLink, kind: "directory", want: "private" }).code, "reparse_point", P("R9", "verify(dir symlink)"));
    const file = join(target, "a.txt");
    writeFileSync(file, "x");
    const fileLink = join(target, "a-link.txt");
    symlinkSync(file, fileLink, "file");
    assert.equal(lstatSync(fileLink).isSymbolicLink(), true, P("R9", "file symlink"));
    assert.equal(one({ path: fileLink, kind: "file", want: "owned" }).code, "reparse_point", P("R9", "verify(file symlink)"));
    const hard = join(target, "a-hard.txt");
    linkSync(file, hard);
    assert.equal(lstatSync(file, { bigint: true }).nlink, 2n, P("R9", "nlink of a hard-linked file"));
    const ino = lstatSync(file, { bigint: true }).ino;
    const moved = join(target, "a-moved.txt");
    renameSync(file, moved);
    assert.equal(lstatSync(moved, { bigint: true }).ino, ino, P("R9", "ino is stable across rename"));
  });

  test("win32: a missing or invalid SystemRoot fails closed system_root_invalid; a root without tools is tool_missing", () => {
    const dir = privDir("sysroot");
    const saved = process.env.SystemRoot;
    const fake = join(base, "fake-root");
    mkdirSync(fake);
    try {
      delete process.env.SystemRoot;
      assert.deepEqual(mod.verify([{ path: dir, kind: "directory", want: "private" }]), [{ ok: false, code: "system_root_invalid" }]);
      assert.deepEqual(mod.setPrivate(dir, "directory"), { status: "error", code: "system_root_invalid" });
      assert.deepEqual(mod.readSecurity([{ path: dir, kind: "directory" }]), [{ status: "error", code: "system_root_invalid" }]);
      for (const bad of [`${saved}\\`, `${saved}\\..\\${saved?.split("\\").pop()}`, "Windows", "C:\\does-not-exist-1167"]) {
        process.env.SystemRoot = bad;
        assert.deepEqual(mod.setPrivate(dir, "directory"), { status: "error", code: "system_root_invalid" }, `SystemRoot=${bad}`);
      }
      process.env.SystemRoot = fake;
      assert.deepEqual(mod.verify([{ path: dir, kind: "directory", want: "private" }]), [{ ok: false, code: "tool_missing" }]);
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
    assert.equal(one({ path: dir, kind: "directory", want: "private" }).ok, true, "restored SystemRoot works again");
  });

  test("win32: a deny ACE for the user is refused; a deny ACE for another trustee is tolerated", () => {
    const who = principal();
    const dir = privDir("deny");
    icacls([dir, "/deny", `*${who.userSid}:(WD)`, "/q"]);
    cleanup.push(() => icacls([dir, "/remove:d", `*${who.userSid}`, "/q"]));
    assert.equal(one({ path: dir, kind: "directory", want: "private" }).code, "ace_deny_user");
    const other = privDir("deny-other");
    icacls([other, "/deny", "*S-1-1-0:(WD)", "/q"]);
    assert.equal(one({ path: other, kind: "directory", want: "private" }).ok, true, "P2 tolerates deny ACEs for other trustees");
  });

  test("win32 R3: owner Administrators is accepted for a directory only when the token is elevated", () => {
    const who = principal();
    const real = facts(privDir("owner-base"), "directory");
    const adminOwned = { ...real, ownerSid: "S-1-5-32-544" };
    assert.deepEqual(mod.checkPrivate(adminOwned, "directory", { ...who, elevatedAdmin: true }), { ok: true });
    assert.deepEqual(mod.checkPrivate(adminOwned, "directory", { ...who, elevatedAdmin: false }), { ok: false, code: "owner_mismatch" });
    assert.deepEqual(mod.checkPrivate({ ...real, ownerSid: "S-1-5-18" }, "directory", { ...who, elevatedAdmin: true }),
      { ok: false, code: "owner_mismatch" });
    // R2 (d): a file inside a verified-private directory accepts Administrators regardless of elevation.
    const fileFacts = { ...real, ownerSid: "S-1-5-32-544", control: 0x8404, dacl: [{ type: 0, flags: 0x10, mask: FULL, sid: who.userSid }] };
    assert.deepEqual(mod.checkPrivate(fileFacts, "file", { ...who, elevatedAdmin: false }, { parentPrivate: true }), { ok: true });
    if (!who.elevatedAdmin) {
      assert.fail(P("R3", "the real owner-Administrators case needs an elevated token (windows-latest is elevated); this token is not elevated"));
    }
    const dir = privDir("owner-admin");
    acl.setOwner(dir, "*S-1-5-32-544");
    assert.equal(facts(dir, "directory").ownerSid, "S-1-5-32-544", P("R3", "icacls /setowner Administrators"));
    assert.equal(one({ path: dir, kind: "directory", want: "private" }).ok, true, P("R3", "elevated token accepts Administrators owner"));
    assert.deepEqual(mod.checkPrivate(facts(dir, "directory"), "directory", { ...who, elevatedAdmin: false }), { ok: false, code: "owner_mismatch" });
  });

  test("win32: a non-protected (inheriting) DACL is refused dacl_not_protected", () => {
    const dir = privDir("unprotected");
    icacls([dir, "/inheritance:e", "/q"]);
    assert.equal(one({ path: dir, kind: "directory", want: "private" }).code, "dacl_not_protected");
    assert.doesNotMatch(acl.daclText(dir), /^D:P/);
    assert.equal(acl.isPrivate(dir), false);
  });

  test("win32 R2 (Q-FILE): a file inside a verified-private directory is accepted without its own Set", () => {
    const who = principal();
    const dir = privDir("files");
    const file = join(dir, "secret.json");
    writeFileSync(file, "{}");
    const [dv, fv] = mod.verify([{ path: dir, kind: "directory", want: "private" }, { path: file, kind: "file", want: "private" }]);
    assert.equal(dv!.ok, true);
    assert.equal(fv!.ok, true, P("R2", `file in private directory: ${JSON.stringify(fv)}`));
    const f = facts(file, "file");
    assert.ok(f.dacl!.length > 0 && f.dacl!.every((a) => a.type === 0 && (a.flags & 0x10) !== 0 && a.sid === who.userSid),
      P("R2", `the file holds only inherited user ACEs: ${JSON.stringify(f.dacl)}`));
    assert.equal(one({ path: file, kind: "file", want: "private" }).code, "dacl_not_protected", "the parent must be in the same batch");
    assert.equal(one({ path: file, kind: "file", want: "owned" }).ok, true);
    assert.deepEqual(mod.setPrivate(file, "file"), { status: "error", code: "path_invalid" }, "files never get a Set");
    assert.deepEqual(mod.setPrivate(dir, "file"), { status: "error", code: "path_invalid" });
    assert.deepEqual(mod.checkPrivate(f, "file", who), { ok: false, code: "dacl_not_protected" });
    assert.deepEqual(mod.checkPrivate(f, "file", who, { parentPrivate: true }), { ok: true });
    acl.makePrivate(file);
    assert.equal(acl.isPrivate(file), true);
  });

  test("win32 R2 (Q-FILE): a file inside a non-private directory is refused", () => {
    const dir = join(base, "plain");
    mkdirSync(dir);
    const file = join(dir, "secret.json");
    writeFileSync(file, "{}");
    const [dv, fv] = mod.verify([{ path: dir, kind: "directory", want: "private" }, { path: file, kind: "file", want: "private" }]);
    assert.equal(dv!.ok, false);
    assert.equal(fv!.code, "dacl_not_protected");
    assert.throws(() => acl.makePrivate(file), /parent directory is not private/);
    assert.equal(acl.isPrivate(file), false);
  });

  test("win32 R5: a Unicode path (é世😀) works end to end", () => {
    const dir = privDir("uni-é世😀", "R5");
    const file = join(dir, "파일-é世😀.txt");
    writeFileSync(file, "x");
    const [dv, fv] = mod.verify([{ path: dir, kind: "directory", want: "private" }, { path: file, kind: "file", want: "private" }]);
    assert.ok(dv!.ok && fv!.ok, P("R5", `Unicode path verify: ${JSON.stringify([dv, fv])}`));
    assert.equal(acl.isPrivate(dir), true, P("R5", "Unicode oracle"));
  });

  test("win32 R5: a 300-character Unicode path works end to end (\\\\?\\ form for icacls and PowerShell)", () => {
    let dir = join(base, "long-é世😀");
    for (let i = 0; dir.length < 300; i++) dir = join(dir, `${String(i).padStart(2, "0")}-${"x".repeat(56)}`);
    const parent = resolve(dir, "..");
    mkdirSync(parent, { recursive: true });
    mkdirSync(dir);
    assert.ok(dir.length >= 300, `fixture length ${dir.length}`);
    const set = mod.setPrivate(dir, "directory");
    assert.deepEqual(set, { status: "ok" },
      P("R5", `icacls on a ${dir.length}-char path failed: ${JSON.stringify(set)}. If this fails, P4 long-path support for private items is unmet: HOLD to the controller (PLAN §6 R5).`));
    const file = join(dir, "leaf-é世😀.txt");
    writeFileSync(file, "x");
    const [dv, fv] = mod.verify([{ path: dir, kind: "directory", want: "private" }, { path: file, kind: "file", want: "private" }]);
    assert.ok(dv!.ok && fv!.ok, P("R5", `PowerShell read-back on a ${dir.length}-char path: ${JSON.stringify([dv, fv])}`));
    assert.equal(acl.isPrivate(dir), true, P("R5", "oracle on the long path"));
  });

  test("win32: createSession memoises within one call and flush verifies pending objects", () => {
    const dir = privDir("session");
    const s = mod.createSession();
    assert.equal(s.status, "ok");
    if (s.status !== "ok") return;
    assert.deepEqual(s.markSet(dir, "directory"), { status: "ok" });
    const pend = s.require(dir, "private");
    assert.equal(pend.ok, true);
    assert.equal(pend.digest, undefined, "a pending directory is accepted unread");
    const file = join(dir, "receipt.json");
    writeFileSync(file, "{}");
    const fr = s.require([{ path: file, kind: "file", want: "private" }])[0]!;
    assert.equal(fr.ok, true, `file read with its parent: ${JSON.stringify(fr)}`);
    assert.deepEqual(s.flush(), { status: "ok" });
    const dg = s.digest(dir);
    assert.equal(dg.ok, true);
    assert.equal(dg.digest, one({ path: dir, kind: "directory", want: "private" }).digest);
    // A directory the caller marks but never Set fails at the flush barrier.
    const plain = join(base, "session-plain");
    mkdirSync(plain);
    assert.deepEqual(s.markSet(plain, "directory"), { status: "ok" });
    assert.equal(s.require(plain, "owned").ok, true);
    assert.deepEqual(s.flush(), { status: "error", code: "dacl_not_protected" });
    // Nothing outlives a session: a fresh one sees a tamper.
    acl.grant(dir, "*S-1-1-0:(R)");
    const fresh = mod.createSession();
    assert.equal(fresh.status === "ok" && fresh.require(dir, "private").code, "ace_foreign_allow");
  });

  test("win32: predicates over synthetic facts cover the closed refusal set", () => {
    const who = goodWho();
    const dir = (over: Partial<SecurityFacts>) => mod.checkPrivate(goodFacts(over), "directory", who);
    assert.deepEqual(dir({}), { ok: true });
    assert.deepEqual(dir({ control: 0x9000 }), { ok: false, code: "dacl_absent" });
    assert.deepEqual(dir({ dacl: null }), { ok: false, code: "dacl_null" });
    assert.deepEqual(dir({ control: 0x8404 }), { ok: false, code: "dacl_not_protected" });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }, { type: 5, flags: 0, mask: FULL, sid: "S-1-1-0" }] }),
      { ok: false, code: "ace_unsupported" });
    assert.deepEqual(dir({ dacl: [{ type: 2, flags: 0, mask: null, sid: null }] }), { ok: false, code: "ace_unsupported" });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }, { type: 0, flags: 0, mask: 0x120089, sid: "S-1-5-18" }] }),
      { ok: false, code: "ace_foreign_allow" });
    assert.deepEqual(dir({ dacl: [] }), { ok: false, code: "owner_ace_missing" });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }, { type: 1, flags: 0, mask: 2, sid: USER }] }),
      { ok: false, code: "ace_deny_user" });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }, { type: 1, flags: 0, mask: 2, sid: "S-1-1-0" }] }), { ok: true });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 0, mask: FULL, sid: USER }] }), { ok: false, code: "owner_ace_missing" });
    assert.deepEqual(dir({ dacl: [{ type: 0, flags: 0xb, mask: FULL, sid: USER }] }), { ok: false, code: "owner_ace_missing" });
    assert.deepEqual(dir({ ownerSid: "S-1-5-18" }), { ok: false, code: "owner_mismatch" });
    assert.deepEqual(mod.checkPrivate({ status: "error", code: "missing" }, "directory", who), { ok: false, code: "missing" });
    assert.deepEqual(mod.checkPrivate(goodFacts(), "directory", { status: "error", code: "tool_timeout" }),
      { ok: false, code: "principal_unavailable" });
    const owned = (over: Partial<SecurityFacts>) => mod.checkOwned(goodFacts(over), who);
    const plus = (...extra: Ace[]): Partial<SecurityFacts> => ({ dacl: [{ type: 0, flags: 3, mask: FULL, sid: USER }, ...extra] });
    assert.deepEqual(owned(plus({ type: 0, flags: 3, mask: FULL, sid: "S-1-5-18" }, { type: 0, flags: 3, mask: FULL, sid: "S-1-5-32-544" })), { ok: true });
    assert.deepEqual(owned(plus({ type: 0, flags: 3, mask: 0x1200a9, sid: "S-1-5-32-545" })), { ok: true }, "read/execute is not write-class");
    assert.deepEqual(owned(plus({ type: 0, flags: 0, mask: 0x2, sid: "S-1-1-0" })), { ok: false, code: "ace_foreign_write" });
    assert.deepEqual(owned(plus({ type: 0, flags: 0xb, mask: 0x10000000, sid: "S-1-3-0" })), { ok: true }, "inherit-only ACEs are not effective");
    assert.deepEqual(owned(plus({ type: 0, flags: 0, mask: 0x10000000, sid: "S-1-3-0" })), { ok: false, code: "ace_foreign_write" }, "CREATOR OWNER is foreign");
    assert.deepEqual(owned(plus({ type: 0, flags: 0, mask: 0x40000, sid: "S-1-3-4" })), { ok: false, code: "ace_foreign_write" }, "OWNER RIGHTS is foreign");
    assert.deepEqual(owned({ ownerSid: "S-1-5-32-544" }), { ok: false, code: "owner_mismatch" });
    assert.deepEqual(mod.checkOwned(goodFacts({ ownerSid: "S-1-5-32-544" }), goodWho({ elevatedAdmin: true })), { ok: true });
    assert.deepEqual(owned({ dacl: null }), { ok: false, code: "dacl_null" });
    assert.deepEqual(mod.checkOwner(goodFacts({ ownerSid: "S-1-1-0" }), who), { ok: false, code: "owner_mismatch" });
    const a = { type: 0, flags: 3, mask: FULL, sid: USER }, b = { type: 1, flags: 0, mask: 2, sid: "S-1-1-0" };
    assert.equal(mod.aclDigest(goodFacts({ dacl: [a, b] })), mod.aclDigest(goodFacts({ dacl: [b, a] })), "digest is order-insensitive");
    assert.notEqual(mod.aclDigest(goodFacts({ dacl: [a] })), mod.aclDigest(goodFacts({ dacl: [{ ...a, mask: 0x1200a9 }] })));
    assert.notEqual(mod.aclDigest(goodFacts()), mod.aclDigest(goodFacts({ ownerSid: "S-1-5-32-544" })));
    const unknown = mod.describe("not_a_code" as never);
    for (const code of CODES) {
      const text = mod.describe(code);
      assert.ok(text.length > 0 && text !== unknown && !text.includes("\\") && !text.includes("S-1-"), code);
    }
  });

  test("win32 R4: read-batch and icacls latency (diagnostic only, not an assertion)", (t) => {
    const dir = privDir("latency", "R4");
    const file = join(dir, "f.txt");
    writeFileSync(file, "x");
    const pct = (xs: number[], p: number): string => {
      const s = [...xs].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!.toFixed(0);
    };
    const reads: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const r = mod.readSecurity([{ path: dir, kind: "directory" }, { path: file, kind: "file" }]);
      reads.push(performance.now() - t0);
      assert.ok(r.every((x) => x.status === "ok"), P("R4", "a measured read batch failed"));
    }
    const calls: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      icacls([dir]);
      calls.push(performance.now() - t0);
    }
    t.diagnostic(`[probe R4] powershell read batch (2 items) p50=${pct(reads, 0.5)}ms p95=${pct(reads, 0.95)}ms n=10; ` +
      `icacls p50=${pct(calls, 0.5)}ms p95=${pct(calls, 0.95)}ms n=20`);
  });
}
