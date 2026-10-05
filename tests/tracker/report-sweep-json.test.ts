import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// #1172 U-RS — `dispatch-tracker report-sweep --json`, tested through the ACTUAL compiled tracker CLI
// argv (dist/src/tracker/cli.js) in private fixtures only: fake shared dir, fake registry script, fake
// HOME, minimal env (no host TELEPTY/state/daemon). Faults are injected only inside the CLI child by a
// test-owned --import preload that patches node:fs builtins + syncBuiltinESMExports and logs every hit.
// Every expectation below is computed independently from the U-RS contract, never from product output.
const requestedOutput = process.env.RS1172_OUTPUT;
if (requestedOutput !== undefined && !path.isAbsolute(requestedOutput)) throw new Error("RS1172_OUTPUT must be absolute");
const output = requestedOutput ?? fs.mkdtempSync(path.join(os.tmpdir(), "report-sweep-json-"));
const cli = fileURLToPath(new URL("../../src/tracker/cli.js", import.meta.url));
const nowIso = "2026-09-13T12:00:00.000Z";
const now = Date.parse(nowIso);
const base = now - 3_600_000;
const TOKEN = "RS1172-FAULT-TOKEN";
const BODY = "RS1172-BODY-MARKER";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Fixture { root: string; bin: string; state: string; shared: string; registryLog: string; faultLog: string; guardLog: string }
interface Run { code: number | null; signal: string | null; stdout: string; stderr: string; faults: string[] }
interface Entry { b64?: string; mtimeMs: number; mode: number; dir: boolean }
interface Seeded { name: string; bytes: Buffer; mtime: number; kind: string; track: string }

let counter = 0;
const runDir = fs.mkdtempSync(path.join(output, "rsjson-"));
process.stdout.write(`# evidence ${runDir}\n`);

const PRELOAD = `import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cp from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
// Access guard (platform-neutral): logs every node:fs / node:fs/promises call naming a watched path and
// every child_process launch, BEFORE the call runs. Log writes use the captured original appendFileSync.
const guard = JSON.parse(process.env.RS1172_GUARD || "null");
if (guard) {
  const append = fs.appendFileSync;
  const norm = (s) => { const r = path.resolve(s); return process.platform === "win32" ? r.toLowerCase() : r; };
  const watch = guard.watch.map(norm);
  const asPath = (x) => typeof x === "string" ? x : x instanceof URL ? fileURLToPath(x) : Buffer.isBuffer(x) ? x.toString() : null;
  const hit = (api, args) => { for (const x of args) { const s = asPath(x); if (s === null || s === "") continue;
    const n = norm(s); if (watch.some((w) => n === w || n.startsWith(w + path.sep))) append(guard.log, api + " " + s + "\\n"); } };
  for (const [label, obj] of [["fs", fs], ["fsp", fsp]]) for (const k of Object.keys(obj)) {
    const fn = obj[k]; if (typeof fn !== "function" || !/^[a-z]/.test(k)) continue;
    obj[k] = function (...a) { hit(label + "." + k, a); return Reflect.apply(fn, this, a); };
  }
  for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const fn = cp[k]; cp[k] = function (...a) { append(guard.log, "child_process." + k + " " + JSON.stringify(a.slice(0, 2)) + "\\n");
      return Reflect.apply(fn, this, a); };
  }
  syncBuiltinESMExports();
}
const cfg = JSON.parse(process.env.RS1172_FAULT || "null");
if (cfg) {
  const err = (code, file) => { fs.appendFileSync(cfg.log, code + " " + file + "\\n");
    return Object.assign(new Error(code + ": " + cfg.token + " " + file), { code, path: file }); };
  const cursor = path.join(cfg.state, "report-cursor.json");
  const rf = fs.readFileSync, rd = fs.readdirSync, st = fs.statSync, op = fsp.open, ln = fsp.link, ul = fsp.unlink, rn = fsp.rename;
  fs.statSync = function (...a) { if (cfg.kind === "stat" && String(a[0]) === cfg.target) throw err("EACCES", String(a[0]));
    return Reflect.apply(st, fs, a); };
  fs.readFileSync = function (...a) { const f = String(a[0]);
    if (cfg.kind === "read" && f === cfg.target) throw err("EACCES", f);
    if (cfg.kind === "cursor-read" && f === cursor) throw err("EACCES", f);
    return Reflect.apply(rf, fs, a); };
  fs.readdirSync = function (...a) { if (cfg.kind === "discovery" && String(a[0]) === cfg.shared) throw err("EACCES", String(a[0]));
    return Reflect.apply(rd, fs, a); };
  fsp.open = async function (...a) { const f = String(a[0]);
    if (cfg.kind === "copy" && f.includes(path.sep + "inbox" + path.sep) && f.includes("-" + cfg.stem + ".md.tmp.")) throw err("ENOSPC", f);
    if (cfg.kind === "cursor-space" && f.startsWith(cursor + ".tmp.")) throw err("ENOSPC", f);
    if (cfg.kind === "cursor-dir-sync" && f === cfg.state) throw err("EIO", f);
    return Reflect.apply(op, fsp, a); };
  fsp.link = async function (...a) { if (cfg.kind === "lock-acquire" && String(a[1]) === cursor + ".lock") throw err("EACCES", String(a[1]));
    return Reflect.apply(ln, fsp, a); };
  fsp.unlink = async function (...a) { if (cfg.kind === "lock-release" && String(a[0]) === cursor + ".lock") throw err("EPERM", String(a[0]));
    return Reflect.apply(ul, fsp, a); };
  fsp.rename = async function (...a) { if (cfg.kind === "cursor-rename" && String(a[1]) === cursor) throw err("EIO", String(a[1]));
    return Reflect.apply(rn, fsp, a); };
  syncBuiltinESMExports();
}
`;
const preload = path.join(runDir, "fault-preload.mjs");
fs.writeFileSync(preload, PRELOAD);

function fixture(name: string, stateOverride?: string): Fixture {
  const root = path.join(runDir, `${String(++counter).padStart(2, "0")}-${name}`);
  const bin = path.join(root, "bin");
  const shared = path.join(root, "shared");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(shared);
  fs.mkdirSync(path.join(root, "home"));
  fs.mkdirSync(path.join(root, "tmp"));
  const registryLog = path.join(root, "registry-calls.log");
  const snapshot = JSON.stringify({ schema_version: 2, generation: 1, dispatches: [{ assigned: { sid: "zz777-coder" } }] });
  // win32: the tracker runs DISPATCH_REGISTRY_PY as `python <script>` (registry seam), so the same fake is Python there.
  if (win) fs.writeFileSync(path.join(bin, REGISTRY), `import sys\nwith open(${JSON.stringify(registryLog)}, "a", encoding="utf-8") as fh:\n` +
    `    fh.write(" ".join(sys.argv[1:]) + "\\n")\nsys.stdout.write(${JSON.stringify(snapshot)})\n`);
  else fs.writeFileSync(path.join(bin, REGISTRY), `#!/bin/sh\necho "$@" >> '${registryLog}'\nprintf '%s' '${snapshot}'\n`, { mode: 0o700 });
  return { root, bin, state: stateOverride ?? path.join(root, "state"), shared, registryLog, faultLog: path.join(root, "faults.log"),
    guardLog: path.join(root, "guard.log") };
}

function seed(f: Fixture, s: Seeded): void {
  const file = path.join(f.shared, `${s.name}.md`);
  fs.writeFileSync(file, s.bytes, { mode: 0o600 });
  fs.utimesSync(file, s.mtime / 1000, s.mtime / 1000);
}

function walk(dir: string, prefix = "", out: Record<string, Entry> = {}): Record<string, Entry> {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name), rel = path.join(prefix, e.name), st = fs.statSync(file);
    if (e.isDirectory()) { out[rel + "/"] = { mtimeMs: st.mtimeMs, mode: st.mode & 0o777, dir: true }; walk(file, rel, out); }
    else out[rel] = { b64: fs.readFileSync(file).toString("base64"), mtimeMs: st.mtimeMs, mode: st.mode & 0o777, dir: false };
  }
  return out;
}

const win = process.platform === "win32";
const REGISTRY = win ? "fake-registry.py" : "fake-registry.sh";
function env(f: Fixture, fault?: Record<string, string>, guarded = false): NodeJS.ProcessEnv {
  const home = path.join(f.root, "home"), tmp = path.join(f.root, "tmp");
  return { PATH: win ? (process.env.PATH ?? "") : "/usr/bin:/bin", HOME: home, TMPDIR: tmp,
    ...(win ? { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: home, TEMP: tmp, TMP: tmp } : {}),
    AIGENTRY_SHIM_SCRIPT_DIR: f.bin, DISPATCH_STATE_DIR: f.state, TELEPTY_SHARED_DIR: f.shared,
    DISPATCH_REGISTRY_PY: path.join(f.bin, REGISTRY), TRACKER_NOW: nowIso,
    ...(guarded ? { RS1172_GUARD: JSON.stringify({ log: f.guardLog, watch: [f.state, f.shared, path.join(f.bin, REGISTRY)] }) } : {}),
    ...(fault ? { RS1172_FAULT: JSON.stringify({ log: f.faultLog, token: TOKEN, state: f.state, shared: f.shared, ...fault }) } : {}) };
}
function guardHits(f: Fixture): string[] {
  return fs.existsSync(f.guardLog) ? fs.readFileSync(f.guardLog, "utf8").split("\n").filter(Boolean) : [];
}

function faults(f: Fixture): string[] {
  return fs.existsSync(f.faultLog) ? fs.readFileSync(f.faultLog, "utf8").split("\n").filter(Boolean) : [];
}

function record(f: Fixture, label: string, argv: string[], r: Run, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(f.root, `${label}.run.json`), JSON.stringify({ argv, ...r, ...extra }, null, 2) + "\n");
}

function run(f: Fixture, label: string, args: string[], fault?: Record<string, string>, guarded = false): Run {
  // A file URL, not a path: a drive-letter path is rejected by --import on Windows.
  const argv = [...(fault || guarded ? ["--import", pathToFileURL(preload).href] : []), cli, ...args];
  const p = spawnSync(process.execPath, argv, { cwd: f.root, env: env(f, fault, guarded), encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(p.error, undefined, `${label}: launch/timeout ${p.error?.message}`);
  const r: Run = { code: p.status, signal: p.signal, stdout: p.stdout, stderr: p.stderr, faults: faults(f) };
  record(f, label, argv, r);
  return r;
}

/** Independent refId per contract: safe sanitised basename, digest-suffixed only when information was dropped. */
function refId(stem: string): string {
  const clean = stem.replace(/[^A-Za-z0-9._-]/g, "");
  if (clean === stem && clean.length && clean.length <= 96 && clean !== "." && clean !== "..") return clean;
  let seg = clean.slice(0, 87);
  if (!seg || seg === "." || seg === "..") seg = "unknown";
  return `${seg}-${createHash("sha256").update(stem, "utf8").digest("hex").slice(0, 8)}`;
}

function shownInbox(f: Fixture, s: Seeded): string {
  const rel = s.kind === "?" ? path.join("inbox", "unclassified", `${day(s.mtime)}-${refId(s.name)}.md`)
    : path.join("inbox", `${day(s.mtime)}-${s.track}-${refId(s.name)}.md`);
  const abs = path.join(f.state, rel);
  return abs.startsWith(f.root + path.sep) ? path.relative(f.root, abs) : abs;
}

function nameMatch(stem: string, bytes: Buffer): boolean | null {
  return /^[0-9a-f]{64}$/.test(stem) ? stem === sha(bytes) : null;
}

function expectedItem(f: Fixture, s: Seeded) {
  return { track: s.track, kind: s.kind, sha256: sha(s.bytes), bytes: s.bytes.length, ref_id: refId(s.name),
    name_matches_content: nameMatch(s.name, s.bytes), inbox: shownInbox(f, s), mtime_ms: s.mtime, acceptance: "none" };
}

type Doc = { v: number; items: Array<Record<string, unknown>>; pending: Record<string, unknown>; exit: number; acceptance: string };
const ITEM_KEYS = ["acceptance", "bytes", "inbox", "kind", "mtime_ms", "name_matches_content", "ref_id", "sha256", "track"];

/** Strict shape check: exactly one JSON document, no NEW text, no body/exception text, exact keys. */
function doc(r: Run, label: string): Doc {
  assert.ok(!/^NEW /m.test(r.stdout), `${label}: NEW text on stdout in JSON mode`);
  assert.ok(!r.stdout.includes(TOKEN), `${label}: exception text leaked into JSON`);
  assert.ok(!r.stdout.includes(BODY), `${label}: report body leaked into JSON`);
  let d: Doc;
  try { d = JSON.parse(r.stdout) as Doc; } catch (e) { assert.fail(`${label}: stdout is not exactly one JSON document: ${(e as Error).message}; got ${JSON.stringify(r.stdout.slice(0, 300))}`); }
  assert.deepEqual(Object.keys(d).sort(), ["acceptance", "exit", "items", "pending", "v"], `${label}: top-level keys`);
  assert.equal(d.v, 1); assert.equal(d.acceptance, "none"); assert.equal(d.exit, r.code, `${label}: doc.exit must equal process exit`);
  assert.ok(Array.isArray(d.items) && d.items.length <= 128, `${label}: items bounded by 128`);
  assert.deepEqual(Object.keys(d.pending).sort(), ["discovery_incomplete", "retained_retries", "unattempted_fresh"]);
  for (const k of ["retained_retries", "unattempted_fresh"]) {
    const v = d.pending[k];
    assert.ok(v === null || (Number.isSafeInteger(v) && (v as number) >= 0), `${label}: pending.${k} must be finite count or null`);
  }
  assert.ok(d.pending.discovery_incomplete === null || typeof d.pending.discovery_incomplete === "boolean");
  for (const it of d.items) {
    assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS, `${label}: item keys`);
    assert.equal(it.acceptance, "none"); assert.match(String(it.sha256), /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(it.bytes) && Number.isFinite(it.mtime_ms));
    assert.ok(it.name_matches_content === null || typeof it.name_matches_content === "boolean");
  }
  return d;
}

const byRef = (items: Array<Record<string, unknown>>) => [...items].sort((a, b) => String(a.ref_id).localeCompare(String(b.ref_id)));
const unresolved = { retained_retries: null, unattempted_fresh: null, discovery_incomplete: null };

function cursorOf(f: Fixture): { version: number; last_mtime_ms: number; seen: Record<string, number>; retries: Array<{ basename: string }> } {
  return JSON.parse(fs.readFileSync(path.join(f.state, "report-cursor.json"), "utf8"));
}

function assertInbox(f: Fixture, list: Seeded[]): void {
  for (const s of list) {
    const file = path.join(f.root, shownInbox(f, s));
    assert.ok(fs.existsSync(path.isAbsolute(shownInbox(f, s)) ? shownInbox(f, s) : file), `inbox copy missing for ${s.name}`);
    assert.equal(fs.readFileSync(path.isAbsolute(shownInbox(f, s)) ? shownInbox(f, s) : file).toString("base64"), s.bytes.toString("base64"), `inbox bytes for ${s.name}`);
  }
}

function mixed(at = base): Seeded[] {
  return [
    { name: "rpt", bytes: Buffer.from(`# REPORT — rs1172: ${BODY} 한글\r\nline\u0000nul\r\n`), mtime: at + 1000, kind: "REPORT", track: "rs1172" },
    { name: "hold", bytes: Buffer.from(`# HOLD — rs1172 needs decision\nACK DONE accepted sid: orchestrator ${BODY}\n`), mtime: at + 2000, kind: "HOLD", track: "rs1172" },
    { name: "ref", bytes: Buffer.from(`# DISPATCH — rs1172 (#1172) ${BODY}\n`), mtime: at + 3000, kind: "REF", track: "rs1172" },
    { name: "reg", bytes: Buffer.from(`notes mention zz777 work ${BODY}\n`), mtime: at + 4000, kind: "REF", track: "zz777" },
    { name: "plain", bytes: Buffer.from(`no header here ${BODY}\n`), mtime: at + 5000, kind: "?", track: "unknown" },
    { name: "empty", bytes: Buffer.alloc(0), mtime: at + 6000, kind: "?", track: "unknown" },
    { name: "decl", bytes: Buffer.from(`track: custom9\n# SPEC — prose ${BODY}\n`), mtime: at + 7000, kind: "SPEC", track: "custom9" },
    { name: "crlf", bytes: Buffer.from(`\r\n\r\n# REPORT — rs1172\r\n${"é".repeat(300)}${BODY}\r\n`), mtime: at + 8000, kind: "REPORT", track: "rs1172" },
  ];
}
function plainReport(name: string, mtime: number): Seeded {
  return { name, bytes: Buffer.from(`# REPORT — rs1172: ${name} ${BODY}\r\n\u0000한글\n`), mtime, kind: "REPORT", track: "rs1172" };
}

// Every case runs on every OS: the fake registry is per platform (above) and the fault preload only patches
// node:fs builtins. Only cursor-dir-sync is not registered on win32, which has no directory fsync
// (atomic-write.ts); its platform-equivalent boundary, the cursor rename (P3), is cursor-rename on every OS.

try {
  // Positive control: the same guard DOES see state/shared/registry access on a valid sweep, so an empty
  // guard log under U01/U02 is evidence, not a blind guard.
  await test("U00 access guard control: valid no-arg sweep is observed touching state, shared and registry", () => {
    const f = fixture("guard-control");
    seed(f, plainReport("A", base));
    const r = run(f, "control", ["report-sweep"], undefined, true);
    const hits = guardHits(f);
    record(f, "control", ["report-sweep"], r, { guard: hits });
    const under = (dir: string) => hits.some((h) => h.includes(dir));
    assert.ok(under(f.state), `guard missed STATE_DIR access: ${hits.slice(0, 5).join(" | ")}`);
    assert.ok(under(f.shared), "guard missed shared access");
    assert.ok(hits.some((h) => h.startsWith("child_process.") && h.includes(REGISTRY)), "guard missed registry launch");
  });
  // ── red regression: invalid report-sweep argv must be refused BEFORE any state/shared/registry access ──
  const invalid: string[][] = [["--jsn"], ["--json", "--json"], ["--json", "extra"], ["extra"], ["--JSON"], ["--json=1"],
    ["-j"], ["--json", "--jsn"], ["--jsn", "--json"], ["--"], [""], ["--help"]];
  for (const args of invalid) {
    await test(`U01 invalid argv ${JSON.stringify(args)}: exit 4, no STATE_DIR mkdir, no shared/registry access`, () => {
      const f = fixture("invalid-fresh");
      seed(f, plainReport("A", base));
      const sharedBefore = walk(f.shared);
      const r = run(f, "invalid", ["report-sweep", ...args], undefined, true);
      const observed = { stateCreated: fs.existsSync(f.state), stateEntries: Object.keys(walk(f.state)),
        registryCalled: fs.existsSync(f.registryLog), guard: guardHits(f) };
      record(f, "invalid", ["report-sweep", ...args], r, { observed });
      assert.equal(r.code, 4, `expected usage exit 4; observed ${r.code} with ${JSON.stringify(observed)}`);
      assert.equal(observed.stateCreated, false, "STATE_DIR was created by invalid argv");
      assert.equal(observed.registryCalled, false, "registry invoked by invalid argv");
      assert.deepEqual(observed.guard, [], "state/shared/registry touched or child process launched by invalid argv");
      assert.deepEqual(walk(f.shared), sharedBefore);
      assert.ok(!/^NEW /m.test(r.stdout) && !r.stdout.trimStart().startsWith("{"), "invalid argv must not emit sweep output");
    });
  }
  await test("U02 invalid argv against an existing store: every byte, mtime and entry unchanged", () => {
    const f = fixture("invalid-existing");
    fs.mkdirSync(path.join(f.state, "inbox"), { recursive: true });
    fs.writeFileSync(path.join(f.state, "report-cursor.json"), JSON.stringify({ version: 2, last_mtime_ms: base - 600_000, seen: {}, retries: [] }) + "\n");
    seed(f, plainReport("A", base));
    const before = { state: walk(f.state), shared: walk(f.shared) };
    const r = run(f, "invalid", ["report-sweep", "--jsn"], undefined, true);
    const after = { state: walk(f.state), shared: walk(f.shared) };
    record(f, "invalid", ["report-sweep", "--jsn"], r, { before, after, guard: guardHits(f) });
    assert.equal(r.code, 4);
    assert.deepEqual(after, before, "invalid argv mutated state/shared");
    assert.deepEqual(guardHits(f), [], "state/shared/registry touched or child process launched by invalid argv");
  });

  // ── default text mode: byte-equivalent, independently computed ──
  await test("U03 default no-arg text: exact NEW lines, exit 0, empty stderr, exact store", () => {
    const f = fixture("text");
    const list = mixed();
    for (const s of list) seed(f, s);
    const sharedBefore = walk(f.shared);
    const r = run(f, "text", ["report-sweep"]);
    const expected = list.map((s) => `NEW ${s.track} ${s.kind} ${shownInbox(f, s)}\n`).join("");
    assert.equal(r.code, 0); assert.equal(r.stderr, ""); assert.equal(r.stdout, expected);
    assertInbox(f, list);
    const c = cursorOf(f);
    assert.deepEqual(Object.keys(c).sort(), ["last_mtime_ms", "retries", "seen", "version"], "no new cursor fields");
    assert.equal(c.version, 2); assert.equal(c.last_mtime_ms, base + 8000); assert.deepEqual(c.retries, []);
    assert.deepEqual(Object.keys(c.seen).sort(), list.map((s) => refId(s.name)).sort());
    assert.deepEqual(walk(f.shared), sharedBefore, "source unchanged");
    assert.ok(fs.existsSync(f.registryLog), "fake registry (not host) supplied track vocabulary");
    const again = run(f, "text-again", ["report-sweep"]);
    assert.equal(again.code, 0); assert.equal(again.stdout, ""); assert.equal(again.stderr, "");
  });

  // ── JSON mode, valid ──
  await test("U04 --json mixed REPORT/HOLD/REF/registry/unclassified/empty/Unicode/CRLF/NUL: exact items, same store as text", () => {
    const f = fixture("json");
    const list = mixed();
    for (const s of list) seed(f, s);
    const sharedBefore = walk(f.shared);
    const r = run(f, "json", ["report-sweep", "--json"]);
    const d = doc(r, "U04");
    assert.equal(r.code, 0);
    assert.deepEqual(byRef(d.items), byRef(list.map((s) => expectedItem(f, s))));
    assert.deepEqual(d.pending, { retained_retries: 0, unattempted_fresh: 0, discovery_incomplete: false });
    assertInbox(f, list);
    const c = cursorOf(f);
    assert.deepEqual(Object.keys(c).sort(), ["last_mtime_ms", "retries", "seen", "version"]);
    assert.deepEqual(Object.keys(c.seen).sort(), list.map((s) => refId(s.name)).sort());
    assert.deepEqual(walk(f.shared), sharedBefore, "source unchanged");
    const again = doc(run(f, "json-again", ["report-sweep", "--json"]), "U04 again");
    assert.deepEqual(again.items, []); assert.deepEqual(again.pending, { retained_retries: 0, unattempted_fresh: 0, discovery_incomplete: false });
  });
  await test("U05 --json valid empty (empty shared and absent shared): exact empty document", () => {
    const f = fixture("empty");
    const empty = { v: 1, items: [], pending: { retained_retries: 0, unattempted_fresh: 0, discovery_incomplete: false }, exit: 0, acceptance: "none" };
    const r = run(f, "empty", ["report-sweep", "--json"]);
    assert.deepEqual(doc(r, "U05"), empty); assert.equal(r.code, 0);
    fs.rmSync(f.shared, { recursive: true });
    const r2 = run(f, "absent", ["report-sweep", "--json"]);
    assert.deepEqual(doc(r2, "U05 absent"), empty); assert.equal(r2.code, 0);
    assert.equal(fs.existsSync(f.shared), false, "absent shared dir must not be created");
  });
  await test("U06 name_matches_content: digest stem true, other hex false, upper/short/plain/unsafe null; ref_id safe", () => {
    const f = fixture("names");
    const body = (n: number) => Buffer.from(`# REPORT — rs1172: n${n}\n`);
    const b = [1, 2, 3, 4, 5, 6].map(body);
    const list: Seeded[] = [
      { name: sha(b[0]!), bytes: b[0]!, mtime: base + 1000, kind: "REPORT", track: "rs1172" },
      { name: sha(b[0]!), bytes: b[1]!, mtime: base + 2000, kind: "REPORT", track: "rs1172" },
      { name: sha(b[2]!).toUpperCase(), bytes: b[2]!, mtime: base + 3000, kind: "REPORT", track: "rs1172" },
      { name: sha(b[3]!).slice(0, 63), bytes: b[3]!, mtime: base + 4000, kind: "REPORT", track: "rs1172" },
      { name: "rel-874-plain", bytes: b[4]!, mtime: base + 5000, kind: "REPORT", track: "rs1172" },
      // `"` is not a legal win32 file-name character; `'` is another unsafe one that is.
      { name: win ? "we ird'ü!" : "we ird\"ü!", bytes: b[5]!, mtime: base + 6000, kind: "REPORT", track: "rs1172" },
    ];
    // Same digest stem cannot name two files; the mismatch case gets its own stem of a different body.
    list[1] = { ...list[1]!, name: sha(Buffer.from("other content")) };
    for (const s of list) seed(f, s);
    const d = doc(run(f, "names", ["report-sweep", "--json"]), "U06");
    assert.deepEqual(byRef(d.items), byRef(list.map((s) => expectedItem(f, s))));
    const by = new Map(d.items.map((i) => [i.ref_id, i.name_matches_content]));
    assert.deepEqual(list.map((s) => by.get(refId(s.name))), [true, false, null, null, null, null]);
  });
  await test("U07 128 cap: 130 fresh -> 128 items + 2 unattempted, then 2 + 0", () => {
    const f = fixture("cap");
    const list = Array.from({ length: 130 }, (_, i) => plainReport(`n-${String(i).padStart(3, "0")}`, base + i * 1000));
    for (const s of list) seed(f, s);
    const d1 = doc(run(f, "tick1", ["report-sweep", "--json"]), "U07 t1");
    assert.equal(d1.items.length, 128); assert.deepEqual(d1.pending, { retained_retries: 0, unattempted_fresh: 2, discovery_incomplete: false });
    assert.deepEqual(byRef(d1.items), byRef(list.slice(0, 128).map((s) => expectedItem(f, s))));
    const d2 = doc(run(f, "tick2", ["report-sweep", "--json"]), "U07 t2");
    assert.deepEqual(byRef(d2.items), byRef(list.slice(128).map((s) => expectedItem(f, s))));
    assert.deepEqual(d2.pending, { retained_retries: 0, unattempted_fresh: 0, discovery_incomplete: false });
  });
  await test("U08 pending rotation: 70 retained retries + 100 fresh -> 64+64 items, 6 retained, 36 unattempted", () => {
    const f = fixture("rotation");
    const retries = Array.from({ length: 70 }, (_, i) => plainReport(`r-${String(i).padStart(3, "0")}`, base - 7_200_000));
    const fresh = Array.from({ length: 100 }, (_, i) => plainReport(`f-${String(i).padStart(3, "0")}`, base + i * 1000));
    for (const s of [...retries, ...fresh]) seed(f, s);
    fs.mkdirSync(f.state, { recursive: true });
    fs.writeFileSync(path.join(f.state, "report-cursor.json"), JSON.stringify({ version: 2, last_mtime_ms: base - 60_000, seen: {},
      retries: retries.map((s) => ({ basename: `${s.name}.md`, observed_mtime_ms: s.mtime, error_code: "EACCES", first_seen_at: new Date(base).toISOString() })) }));
    const d1 = doc(run(f, "tick1", ["report-sweep", "--json"]), "U08 t1");
    assert.deepEqual(byRef(d1.items), byRef([...retries.slice(0, 64), ...fresh.slice(0, 64)].map((s) => expectedItem(f, s))));
    assert.deepEqual(d1.pending, { retained_retries: 6, unattempted_fresh: 36, discovery_incomplete: false });
    assert.equal(cursorOf(f).retries.length, 6, "retained_retries mirrors this sweep's committed retries");
    const d2 = doc(run(f, "tick2", ["report-sweep", "--json"]), "U08 t2");
    assert.deepEqual(byRef(d2.items), byRef([...retries.slice(64), ...fresh.slice(64)].map((s) => expectedItem(f, s))));
    assert.deepEqual(d2.pending, { retained_retries: 0, unattempted_fresh: 0, discovery_incomplete: false });
  });
  await test("U09 absolute shown inbox path outside repo with quote/backslash/Unicode is JSON-escaped verbatim", () => {
    // win32: `"` cannot be in a file name and `\` is the separator, which every absolute path there already carries.
    const outside = path.join(runDir, win ? `outside-stü\\ate-${counter + 1}` : `outside-st"ü\\ate-${counter + 1}`);
    const f = fixture("outside", outside);
    const s = plainReport("A", base);
    seed(f, s);
    const d = doc(run(f, "outside", ["report-sweep", "--json"]), "U09");
    assert.ok(path.isAbsolute(shownInbox(f, s)));
    assert.deepEqual(d.items, [expectedItem(f, s)]);
  });

  // ── JSON mode, faults ──
  await test("U10 unreadable ref: existing exit 0, truthful pending, no item/copy for A, B committed", () => {
    const f = fixture("unreadable");
    const a = plainReport("A", base + 1000), b = plainReport("B", base + 2000);
    seed(f, a); seed(f, b);
    const r = run(f, "fault", ["report-sweep", "--json"], { kind: "read", target: path.join(f.shared, "A.md") });
    assert.ok(r.faults.length >= 1, "fault fired"); const d = doc(r, "U10");
    assert.equal(r.code, 0); assert.deepEqual(d.items, [expectedItem(f, b)]);
    assert.deepEqual(d.pending, { retained_retries: 1, unattempted_fresh: 0, discovery_incomplete: false });
    assert.deepEqual(cursorOf(f).retries.map((x) => x.basename), ["A.md"]);
    assert.match(r.stderr, /report-sweep: PENDING unreadable ref/, "default diagnostic preserved on stderr");
  });
  await test("U11 inbox copy ENOSPC: existing exit 3, A never itemised, any items are committed ones", () => {
    const f = fixture("copy");
    const a = plainReport("A", base + 1000), b = plainReport("B", base + 2000);
    seed(f, a); seed(f, b);
    const r = run(f, "fault", ["report-sweep", "--json"], { kind: "copy", stem: "A" });
    assert.ok(r.faults.length >= 1, "fault fired"); const d = doc(r, "U11");
    assert.equal(r.code, 3);
    assert.ok(d.items.length === 0 || JSON.stringify(d.items) === JSON.stringify([expectedItem(f, b)]), JSON.stringify(d.items));
    assert.ok(d.pending.retained_retries === 1 || d.pending.retained_retries === null);
    assertInbox(f, [b]); assert.deepEqual(cursorOf(f).retries.map((x) => x.basename), ["A.md"]);
  });
  for (const kind of ["cursor-space", ...(win ? [] : ["cursor-dir-sync"]), "cursor-rename", "lock-release", "lock-acquire", "cursor-read"]) {
    await test(`U12 ${kind}: exit 3, items [], pending all null, evidence kept, sanitised stdout`, () => {
      const f = fixture(kind);
      fs.mkdirSync(f.state, { recursive: true });
      const cursorRaw = JSON.stringify({ version: 2, last_mtime_ms: base - 60_000, seen: {}, retries: [] }) + "\n";
      fs.writeFileSync(path.join(f.state, "report-cursor.json"), cursorRaw);
      const a = plainReport("A", base + 1000), b = plainReport("B", base + 2000);
      seed(f, a); seed(f, b);
      const sharedBefore = walk(f.shared);
      const r = run(f, "fault", ["report-sweep", "--json"], { kind });
      assert.ok(r.faults.length >= 1, "fault fired");
      const d = doc(r, `U12 ${kind}`);
      assert.equal(r.code, 3); assert.deepEqual(d.items, []); assert.deepEqual(d.pending, unresolved);
      assert.ok(r.stderr.length > 0, "default diagnostics on stderr");
      assert.deepEqual(walk(f.shared), sharedBefore, "source unchanged");
      if (kind === "lock-acquire" || kind === "cursor-read") {
        assert.equal(fs.readFileSync(path.join(f.state, "report-cursor.json"), "utf8"), cursorRaw);
        assert.equal(fs.existsSync(path.join(f.state, "inbox")), false);
      } else assertInbox(f, [a, b]); // copies are evidence; never rolled back
      if (kind === "cursor-space" || kind === "cursor-rename") assert.equal(fs.readFileSync(path.join(f.state, "report-cursor.json"), "utf8"), cursorRaw);
      if (kind === "cursor-dir-sync") assert.ok(cursorOf(f).seen.A !== undefined, "post-rename cursor retained, not rolled back");
    });
  }
  await test("U13 invalid cursor JSON: exit 3, items [], pending null, cursor byte-identical", () => {
    const f = fixture("bad-cursor");
    fs.mkdirSync(f.state, { recursive: true }); fs.writeFileSync(path.join(f.state, "report-cursor.json"), "{broken");
    seed(f, plainReport("A", base));
    const r = run(f, "bad", ["report-sweep", "--json"]); const d = doc(r, "U13");
    assert.equal(r.code, 3); assert.deepEqual(d.items, []); assert.deepEqual(d.pending, unresolved);
    assert.equal(fs.readFileSync(path.join(f.state, "report-cursor.json"), "utf8"), "{broken");
  });
  await test("U14 discovery EACCES: exit 3, discovery_incomplete true, unattempted_fresh not invented", () => {
    const f = fixture("discovery");
    const a = plainReport("A", base - 7_200_000);
    seed(f, a); seed(f, plainReport("B", base));
    fs.mkdirSync(f.state, { recursive: true });
    fs.writeFileSync(path.join(f.state, "report-cursor.json"), JSON.stringify({ version: 2, last_mtime_ms: base - 60_000, seen: {},
      retries: [{ basename: "A.md", observed_mtime_ms: a.mtime, error_code: "EACCES", first_seen_at: new Date(base).toISOString() }] }));
    const r = run(f, "fault", ["report-sweep", "--json"], { kind: "discovery" });
    assert.ok(r.faults.length >= 1, "fault fired"); const d = doc(r, "U14");
    assert.equal(r.code, 3);
    assert.equal(d.pending.discovery_incomplete, true); assert.equal(d.pending.unattempted_fresh, null);
    assert.deepEqual(d.items, [expectedItem(f, a)], "known retry recovered and committed");
  });
  await test("U17 single-entry stat EACCES: exit 3, B itemised, retained count committed, unattempted_fresh null, floor frozen", () => {
    const f = fixture("stat");
    const b = plainReport("B", base + 2000);
    seed(f, plainReport("A", base + 1000)); seed(f, b);
    fs.mkdirSync(f.state, { recursive: true });
    // R is a retained retry whose source is absent: it is retried (ENOENT) and stays committed as 1.
    fs.writeFileSync(path.join(f.state, "report-cursor.json"), JSON.stringify({ version: 2, last_mtime_ms: base - 60_000, seen: {},
      retries: [{ basename: "R.md", observed_mtime_ms: base - 120_000, error_code: "EACCES", first_seen_at: new Date(base).toISOString() }] }));
    const sharedBefore = walk(f.shared);
    const r = run(f, "fault", ["report-sweep", "--json"], { kind: "stat", target: path.join(f.shared, "A.md") });
    assert.ok(r.faults.length >= 1, "fault fired"); const d = doc(r, "U17");
    assert.equal(r.code, 3);
    assert.deepEqual(d.items, [expectedItem(f, b)]);
    assert.deepEqual(d.pending, { retained_retries: 1, unattempted_fresh: null, discovery_incomplete: true });
    const c = cursorOf(f);
    assert.deepEqual(c.retries.map((x) => x.basename), ["R.md"]);
    assert.equal(c.last_mtime_ms, base - 60_000, "discovery floor must not advance past the unstatted entry");
    assert.equal(c.seen.A, undefined); assertInbox(f, [b]);
    assert.ok(!fs.readdirSync(path.join(f.state, "inbox")).some((n) => n.endsWith("-A.md")), "no copy for unstatted A");
    assert.match(r.stderr, /report-sweep: PENDING stat /, "default diagnostic preserved on stderr");
    assert.deepEqual(walk(f.shared), sharedBefore, "source unchanged");
  });
  await test("U15 text mode lock-release failure keeps existing best-effort semantics (exit 0, NEW lines)", () => {
    const f = fixture("text-lock-release");
    const a = plainReport("A", base);
    seed(f, a);
    const r = run(f, "fault", ["report-sweep"], { kind: "lock-release" });
    assert.ok(r.faults.length >= 1, "fault fired");
    assert.equal(r.code, 0); assert.equal(r.stdout, `NEW rs1172 REPORT ${shownInbox(f, a)}\n`);
  });
  await test("U16 stdout EPIPE in JSON mode: nonzero, no unhandled rejection/error, evidence kept, source unchanged", async () => {
    const f = fixture("epipe");
    const a = plainReport("A", base);
    seed(f, a);
    const sharedBefore = walk(f.shared);
    const argv = [cli, "report-sweep", "--json"];
    const child = spawn(process.execPath, argv, { cwd: f.root, env: env(f), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.destroy();
    let stderr = "";
    child.stderr!.on("data", (x) => { stderr += String(x); });
    const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.on("close", (c, s) => resolve([c, s])));
    clearTimeout(killer);
    record(f, "epipe", argv, { code, signal, stdout: "<closed>", stderr, faults: [] });
    assert.equal(signal, null, `terminated by ${signal}`);
    assert.ok(code !== 0 && code !== null, `EPIPE must be nonzero; got ${code}`);
    assert.ok(!/unhandled|ERR_UNHANDLED/i.test(stderr), `unhandled error/rejection: ${stderr}`);
    assertInbox(f, [a]); assert.deepEqual(walk(f.shared), sharedBefore);
  });
} finally {
  if (requestedOutput === undefined) fs.rmSync(output, { recursive: true, force: true });
}
