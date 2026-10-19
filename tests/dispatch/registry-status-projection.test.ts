import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Source-only author checkpoint: later Linux/macOS execution must explicitly
// admit the interpreter and owned fixture root. No Python discovery in this test.
// Retain every fixture and raw receipt, including failures. No product mocks.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const helper = path.join(repo, "bin/dispatch-registry.py");
const cli = path.join(repo, "dist/src/tracker/cli.js");
const B = 33_554_432;
const OUTPUT_CAP = 1_048_576;
const RECEIPT_PREVIEW_BYTES = 1024;
const RECEIPT_DIAGNOSTIC_CAP = 64 * 1024;
const OLD = "2026-01-01T00:00:00Z";
const NOW = "2026-01-02T00:00:00Z";
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
type ObjectValue = Record<string, unknown>;
interface Observation { kind: string; at: string; terminal: boolean; padding?: string }
interface Authority {
  schema_version: number;
  generation: number;
  synthetic_retained: { order: string[] };
  dispatches: Array<{
    dispatch_id: string; assigned: { sid: string }; dedup: { key: string; ref_hash: string };
    outcome: { state: string; reported_value: null }; lifecycle: { state: string; at: string };
    gate: { state: null }; track: string; role: string; dispatched_at: string;
    last_seen_at: string; last_observation: Observation; observations: Observation[];
    re_dispatch_count: number; keep_alive: boolean;
  }>;
  status_projection?: unknown;
}
interface Case {
  root: string; python: string; pythonBin: string; deadline: number; sequence: number;
  diagnostics: string[]; previewTruncated: boolean;
}
interface Fixture { root: string; state: string; env: Record<string, string>; original: Authority }
interface Receipt {
  code: number | null; signal: NodeJS.Signals | null; faults: string[];
  stdout: Buffer; stderr: Buffer;
}

function begin(name: string): Case {
  assert.ok(process.platform === "linux" || process.platform === "darwin", "Linux/macOS baseline only");
  const python = process.env.AIGENTRY_STATUS_TEST_PYTHON;
  const pythonHash = process.env.AIGENTRY_STATUS_TEST_PYTHON_SHA256;
  const parent = process.env.AIGENTRY_STATUS_TEST_ROOT;
  assert.ok(python && path.isAbsolute(python), "executor must admit an absolute Python executable");
  assert.ok(parent && path.isAbsolute(parent), "executor must admit an owned fixture root");
  assert.equal(fs.realpathSync(python), python, "executor supplies resolved interpreter");
  assert.ok(fs.lstatSync(python).isFile());
  fs.accessSync(python, fs.constants.X_OK);
  assert.match(pythonHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(sha(fs.readFileSync(python)), pythonHash, "selected interpreter bytes remain pinned");
  assert.equal(fs.realpathSync(parent), parent);
  assert.ok(fs.lstatSync(parent).isDirectory());
  const root = fs.mkdtempSync(path.join(parent, `${name}-`));
  const pythonBin = path.join(root, "python-bin");
  fs.mkdirSync(pythonBin, { mode: 0o700 });
  // Actual tracker executes the actual helper shebang. Only this owned symlink
  // is on child PATH; both direct and tracker routes select the admitted Python.
  fs.symlinkSync(python, path.join(pythonBin, "python3"));
  fs.writeFileSync(path.join(root, "admission.json"), JSON.stringify({ python, pythonHash, node: process.execPath,
    helper, cli, pythonBin, platform: process.platform }) + "\n", { mode: 0o600 });
  return { root, python, pythonBin, deadline: Date.now() + 110_000, sequence: 0,
    diagnostics: [], previewTruncated: false };
}

function fixture(c: Case, name: string, large: boolean): Fixture {
  const root = path.join(c.root, name);
  for (const dir of ["state", "home", "config", "cache", "data", "tmp"])
    fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
  const original: Authority = {
    schema_version: 2, generation: 7, synthetic_retained: { order: ["first", "second"] },
    dispatches: [{
      dispatch_id: "synthetic-0001", assigned: { sid: "synthetic-worker" },
      dedup: { key: "synthetic-dedup-0001", ref_hash: "1".repeat(64) },
      outcome: { state: "unknown", reported_value: null },
      lifecycle: { state: "delivery_attempt_started", at: OLD }, gate: { state: null },
      track: "synthetic-track", role: "coder", dispatched_at: OLD, last_seen_at: OLD,
      last_observation: { kind: "synthetic-recent", at: OLD, terminal: false },
      observations: [
        { kind: "synthetic-old", at: OLD, terminal: false, padding: "" },
        { kind: "synthetic-recent", at: OLD, terminal: false },
      ], re_dispatch_count: 0, keep_alive: false,
    }],
  };
  const encode = (): Buffer => Buffer.from(JSON.stringify(original) + "\n", "utf8");
  if (large) original.dispatches[0]!.observations[0]!.padding = "x".repeat(B + 1 - encode().length);
  const bytes = encode();
  assert.ok(large ? bytes.length === B + 1 : bytes.length < B, "encoded UTF-8 fixture size");
  const state = path.join(root, "state");
  fs.writeFileSync(path.join(state, "active.json"), bytes, { flag: "wx", mode: 0o600 });
  // No inherited environment spread; tracker further narrows its registry env.
  const env = {
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"), TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    DISPATCH_STATE_DIR: state, AIGENTRY_SHIM_SCRIPT_DIR: path.join(repo, "bin"),
    PATH: c.pythonBin, LANG: "C", LC_ALL: "C", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
  };
  return { root, state, env, original };
}

// Include directories, lock files and any future projection objects. Ignore only
// access time: a successful read may update it. Never follow fixture symlinks.
function snapshot(root: string): ObjectValue[] {
  const result: ObjectValue[] = [];
  function walk(relative: string): void {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full);
    assert.ok(!stat.isSymbolicLink(), "unexpected fixture symlink");
    const item: ObjectValue = { path: relative, mode: stat.mode, ino: stat.ino,
      size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
    if (stat.isFile()) item.sha256 = sha(fs.readFileSync(full));
    else assert.ok(stat.isDirectory(), "unexpected special fixture entry");
    result.push(item);
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
  }
  walk("");
  return result;
}

async function run(c: Case, f: Fixture, label: string, command: string, args: string[], bound: number): Promise<Receipt> {
  const receiptPath = path.join(c.root, `${++c.sequence}-${label}`);
  const timeout = Math.min(bound, Math.max(0, c.deadline - Date.now()));
  const faults: string[] = [];
  const chunks: Buffer[][] = [[], []];
  const lengths = [0, 0];
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  if (timeout === 0) faults.push("case deadline exhausted before spawn");
  else await new Promise<void>((resolve) => {
    const child = spawn(command, args, { cwd: f.root, env: f.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { faults.push("timeout"); child.kill("SIGKILL"); }, timeout);
    for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on("data", (data: Buffer) => {
      const room = Math.max(0, OUTPUT_CAP - lengths[index]!);
      chunks[index]!.push(data.subarray(0, room));
      lengths[index]! += data.length;
      if (lengths[index]! > OUTPUT_CAP && !faults.includes(`stream ${index} overflow`)) {
        faults.push(`stream ${index} overflow`); child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => { faults.push(error.message); });
    // Preserve direct close/EOF. This is not descendant hard containment.
    child.on("close", (exit, killed) => { clearTimeout(timer); code = exit; signal = killed; resolve(); });
  });
  const stdout = Buffer.concat(chunks[0]!);
  const stderr = Buffer.concat(chunks[1]!);
  fs.writeFileSync(receiptPath + ".stdout", stdout, { mode: 0o600 });
  fs.writeFileSync(receiptPath + ".stderr", stderr, { mode: 0o600 });
  fs.writeFileSync(receiptPath + ".json", JSON.stringify({ command, args, cwd: f.root, env: f.env,
    timeout, code, signal, faults, observedBytes: lengths, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) }, null, 2) + "\n", { mode: 0o600 });
  const preview = (bytes: Buffer, observedBytes: number): ObjectValue => {
    const raw = bytes.subarray(0, RECEIPT_PREVIEW_BYTES);
    const truncated = raw.length < observedBytes;
    c.previewTruncated ||= truncated;
    return { observedBytes, capturedBytes: bytes.length, sha256: sha(bytes), hashScope: "captured-bytes",
      previewEncoding: "base64", previewBytes: raw.length, truncated, rawPreview: raw.toString("base64") };
  };
  c.diagnostics.push(JSON.stringify({ receipt: label, command, args, code, signal, faults,
    stdout: preview(stdout, lengths[0]!), stderr: preview(stderr, lengths[1]!) }));
  return { code, signal, faults, stdout, stderr };
}

function emitReceipts(c: Case, t: { diagnostic(message: string): void }): void {
  let emittedBytes = 0;
  let omitted = 0;
  // Reserve a bounded overflow marker and eight bytes per line for TAP framing.
  // JSON/base64 keeps every receipt on one line, including arbitrary raw bytes.
  for (const line of c.diagnostics) {
    const bytes = Buffer.byteLength(line) + 8;
    if (emittedBytes + bytes > RECEIPT_DIAGNOSTIC_CAP - 256) { omitted++; continue; }
    t.diagnostic(line);
    emittedBytes += bytes;
  }
  if (omitted) t.diagnostic(JSON.stringify({ receiptDiagnosticsOverflow: true, omittedReceipts: omitted,
    emittedBytes, capBytes: RECEIPT_DIAGNOSTIC_CAP }));
  // All invocations and raw on-disk observations precede either failure.
  assert.equal(omitted, 0, "receipt diagnostics exceeded the per-case 64 KiB cap");
  assert.equal(c.previewTruncated, false, "raw receipt preview truncated; minimal one-record regression must fit");
}

async function status(c: Case, f: Fixture, label: string): Promise<Receipt[]> {
  const direct = await run(c, f, label + "-helper", c.python, [helper, "list", "--jsonl", "--live", "--limit", "100"], 10_000);
  const tracker = await run(c, f, label + "-tracker", process.execPath, [cli, "status", "--json", "--live", "--limit", "100"], 10_000);
  return [direct, tracker];
}
function clean(r: Receipt): void {
  assert.deepEqual(r.faults, [], "child execution error (raw receipt retained)");
  assert.equal(r.signal, null, "child signal (raw receipt retained)");
}
function preserve(f: Fixture): void {
  const expected = structuredClone(f.original);
  expected.generation = 8;
  const appended = { kind: "synthetic-publication", at: NOW, terminal: false };
  expected.dispatches[0]!.observations.push(appended);
  expected.dispatches[0]!.last_observation = appended;
  expected.dispatches[0]!.last_seen_at = NOW;
  const actual = JSON.parse(fs.readFileSync(path.join(f.state, "active.json"), "utf8")) as Authority;
  // Only the future private descriptor may be additional. Keep ALL original
  // history (including padding), values and array order in this equality.
  delete actual.status_projection;
  assert.ok(isDeepStrictEqual(actual, expected), "exact documented observation delta and complete retained history");
}
const expectedRow = {
  dispatch_id: "synthetic-0001", "assigned.sid": "synthetic-worker", track: "synthetic-track", role: "coder",
  "lifecycle.state": "delivery_attempt_started", "lifecycle.at": OLD, "gate.state": null,
  "outcome.state": "unknown", "transport.result": null, "transport.at": null, dispatched_at: OLD,
  expected_report_by: null, last_seen_at: NOW, re_dispatch_count: 0, keep_alive: false,
  "last_observation.kind": "synthetic-publication", "last_observation.at": NOW, "dedup.ref_hash": "1".repeat(64),
};
function semantic(r: Receipt, tracker: boolean): ObjectValue {
  clean(r); assert.equal(r.code, 0, "status availability required; see both callers' retained raw receipts");
  assert.equal(r.stderr.length, 0);
  const text = r.stdout.toString("utf8");
  assert.ok(text.endsWith("\n"));
  let value: ObjectValue;
  if (tracker) value = JSON.parse(text) as ObjectValue;
  else {
    const [header, ...rows] = text.slice(0, -1).split("\n").map(line => JSON.parse(line) as ObjectValue);
    assert.ok(header); assert.equal(header.rows, rows.length);
    value = { ...header, rows };
  }
  assert.ok(value.v === 1 || value.v === 2);
  if (tracker) {
    assert.equal(value.scan, value.v === 1 ? "full" : "projection-full");
    if (value.v === 2) assert.equal(value.validation, "commit-bound-projection");
    else assert.ok(!Object.hasOwn(value, "validation"));
    assert.equal(value.evidence, "registry-observation"); assert.equal(value.completion_fact, null);
    assert.equal(value.read_bound_bytes, B);
    delete value.scan; delete value.validation;
  }
  delete value.v;
  const expected: ObjectValue = { generation: 8, unchanged: false, rows: [expectedRow], more: false,
    next_after: null, matching: 1, oversize: 0 };
  if (tracker) Object.assign(expected, { evidence: "registry-observation", completion_fact: null, read_bound_bytes: B });
  assert.deepEqual(value, expected, "full independent expected status semantics");
  return value;
}

test("legacy retained history at B+1 still refuses both bounded status callers", { concurrency: false, timeout: 120_000 }, async t => {
  const c = begin("legacy-history"); t.diagnostic(`retained receipts: ${c.root}`);
  const f = fixture(c, "large", true);
  const before = snapshot(f.root);
  const results = await status(c, f, "legacy"); // Collect BOTH before asserting either.
  emitReceipts(c, t);
  assert.deepEqual(snapshot(f.root), before, "read preserves authority bytes/stat and creates no lock/object");
  for (const [index, r] of results.entries()) {
    clean(r); assert.equal(r.code, 9); assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr.toString("utf8"), index === 0
      ? "dispatch-registry: list --jsonl: registry_too_large\n"
      : "dispatch-tracker: status --json: registry_too_large\n");
  }
});

test("ordinary observe retains all large history while status equals the small-history oracle", { concurrency: false, timeout: 120_000 }, async t => {
  const c = begin("published-history"); t.diagnostic(`retained receipts: ${c.root}`);
  const large = fixture(c, "large", true);
  const small = fixture(c, "small", false);
  const writes: Receipt[] = [];
  for (const f of [large, small]) writes.push(await run(c, f, path.basename(f.root) + "-observe", c.python,
    [helper, "observe", "--sid", "synthetic-worker", "--kind", "synthetic-publication", "--now", NOW], 30_000));
  const before = [snapshot(large.root), snapshot(small.root)];
  const firstLarge = await status(c, large, "large-first");
  const firstSmall = await status(c, small, "small-first");
  const secondLarge = await status(c, large, "large-repeat");
  const secondSmall = await status(c, small, "small-repeat");
  emitReceipts(c, t);
  // All eight status receipts exist before any availability assertion. Do not
  // encode current registry_too_large as success or fabricate a projection.
  for (const r of writes) { clean(r); assert.equal(r.code, 0); assert.equal(r.stdout.length, 0); assert.equal(r.stderr.length, 0); }
  preserve(large); preserve(small);
  assert.ok(fs.statSync(path.join(large.state, "active.json")).size > B);
  assert.deepEqual([snapshot(large.root), snapshot(small.root)], before, "repeated status performs no writes");
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(secondLarge[i], firstLarge[i], "large repeated read identical");
    assert.deepEqual(secondSmall[i], firstSmall[i], "small repeated read identical");
  }
  // Fixed expected rows/counts/unknown outcome are checked as well as differential
  // equality; only documented version/scan/validation metadata is normalized.
  for (let i = 0; i < 2; i++) {
    const oracle = semantic(firstSmall[i]!, i === 1);
    assert.deepEqual(semantic(firstLarge[i]!, i === 1), oracle);
  }
});

// Task 511 independent controls. Everything above this marker is the exact base prefix.
type Diagnostic = { diagnostic(message: string): void };
interface Publication { doc: ObjectValue; descriptor: ObjectValue; object: string; bytes: Buffer; prefix: Buffer }
const fields511 = Object.keys(expectedRow);
const ascii511 = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const options511 = { concurrency: false, timeout: 120_000 };

function record511(id: string, changes: ObjectValue = {}): ObjectValue {
  return { dispatch_id: id, assigned: { sid: "synthetic-worker" },
    dedup: { key: `synthetic-${id}`, ref_hash: "1".repeat(64) },
    outcome: { state: "unknown", reported_value: null }, lifecycle: { state: "delivery_attempt_started", at: OLD },
    gate: { state: null }, dispatched_at: OLD, observations: [], ...changes };
}
function seed511(f: Fixture, records: ObjectValue[]): void {
  fs.writeFileSync(path.join(f.state, "active.json"), ascii511({ schema_version: 2, generation: 7,
    retained: { order: ["first", "second"] }, dispatches: records }) + "\n");
}
async function call511(c: Case, f: Fixture, t: Diagnostic, args: string[], tracker = false,
  program = helper, prefix: string[] = []): Promise<Receipt> {
  const write = args[0] === "observe";
  const r = await run(c, f, `p511-${c.sequence + 1}`, tracker ? process.execPath : c.python,
    tracker ? [cli, "status", "--json", ...args] : [program, ...prefix, ...args], write ? 30_000 : 10_000);
  // Complete output is on disk; console previews are explicitly non-oracles.
  t.diagnostic(c.diagnostics[c.diagnostics.length - 1]!);
  clean(r); return r;
}
function success511(r: Receipt, tracker = false, version = 2): ObjectValue {
  assert.equal(r.code, 0, r.stderr.toString()); assert.equal(r.stderr.length, 0);
  assert.ok(r.stdout.length <= OUTPUT_CAP && r.stdout.toString().endsWith("\n"));
  const lines = r.stdout.toString("ascii").trimEnd().split("\n").map(s => JSON.parse(s) as ObjectValue);
  const head = lines[0]!;
  assert.equal(head.v, version);
  const keys = ["v", "generation", "unchanged", "matching", "oversize", "more", "next_after", "rows"];
  if (tracker) {
    keys.push("scan", "evidence", "completion_fact", "read_bound_bytes");
    if (version === 2) keys.push("validation");
    assert.equal(lines.length, 1); assert.equal(head.scan, version === 2 ? "projection-full" : "full");
    if (version === 2) assert.equal(head.validation, "commit-bound-projection");
    assert.equal(head.evidence, "registry-observation"); assert.equal(head.completion_fact, null);
    assert.equal(head.read_bound_bytes, B);
  } else { assert.equal(head.rows, lines.length - 1); }
  assert.deepEqual(Object.keys(head).sort(), keys.sort());
  const rows = tracker ? head.rows as ObjectValue[] : lines.slice(1);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), [...fields511].sort());
  return { ...head, rows };
}
function refused511(r: Receipt, reason: string, code = 9, tracker = false): void {
  assert.equal(r.code, code); assert.equal(r.stdout.length, 0);
  assert.equal(r.stderr.toString(), `${tracker ? "dispatch-tracker: status --json" : "dispatch-registry: list --jsonl"}: ${reason}\n`);
}
function publication511(f: Fixture): Publication {
  const active = fs.readFileSync(path.join(f.state, "active.json"));
  const doc = JSON.parse(active.toString()) as ObjectValue;
  const descriptor = doc.status_projection as ObjectValue;
  assert.ok(descriptor && typeof descriptor === "object");
  assert.deepEqual(Object.keys(descriptor), ["v", "sha256", "bytes", "rows"]);
  assert.equal(descriptor.v, 1); assert.match(String(descriptor.sha256), /^[a-f0-9]{64}$/);
  const prefix = active.subarray(0, active.indexOf(10) + 1);
  assert.deepEqual(prefix, Buffer.from(ascii511({ schema_version: 2, generation: doc.generation,
    status_projection: descriptor }).slice(0, -1) + ",\n"));
  assert.ok(prefix.length <= 65536);
  const dir = path.join(f.state, "status-projections");
  assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
  // The accepted contract pins digest derivation, not a filename suffix.
  const candidates = fs.readdirSync(dir).filter(n => n === descriptor.sha256 || n === `${descriptor.sha256}.json`);
  assert.equal(candidates.length, 1, "exact immutable digest object");
  const object = path.join(dir, candidates[0]!);
  assert.ok(fs.lstatSync(object).isFile() && !fs.lstatSync(object).isSymbolicLink());
  const bytes = fs.readFileSync(object);
  assert.equal(bytes.length, descriptor.bytes); assert.equal(sha(bytes), descriptor.sha256);
  const parsed = JSON.parse(bytes.toString()) as { v: number; rows: ObjectValue[] };
  assert.deepEqual(Object.keys(parsed), ["v", "rows"]); assert.equal(parsed.v, 1);
  assert.equal(parsed.rows.length, descriptor.rows);
  assert.deepEqual(bytes, Buffer.from(ascii511(parsed) + "\n"));
  for (const row of parsed.rows) assert.deepEqual(Object.keys(row), [...fields511, "gate_invalid", "gated"]);
  return { doc, descriptor, object, bytes, prefix };
}
async function publish511(c: Case, f: Fixture, t: Diagnostic): Promise<Publication> {
  const r = await call511(c, f, t, ["observe", "--sid", "synthetic-worker", "--kind", "synthetic-publication", "--now", NOW]);
  assert.equal(r.code, 0, r.stderr.toString()); assert.equal(r.stdout.length, 0); assert.equal(r.stderr.length, 0);
  return publication511(f);
}
function legacy511(c: Case, p: Publication): Fixture {
  const f = fixture(c, "legacy-oracle", false), doc = structuredClone(p.doc);
  delete doc.status_projection;
  fs.writeFileSync(path.join(f.state, "active.json"), ascii511(doc) + "\n");
  return f;
}
function normalized511(p: ObjectValue): ObjectValue {
  const copy = { ...p }; delete copy.v; delete copy.scan; delete copy.validation;
  return copy;
}

for (const delta of [-1, 0, 1]) for (const multibyte of [false, true])
  test(`P1 legacy UTF-8 byte boundary B${delta < 0 ? "-1" : delta ? "+1" : ""}, multibyte=${multibyte}`, options511, async t => {
    const c = begin("legacy-bound"), f = fixture(c, "state", false);
    const doc = JSON.parse(fs.readFileSync(path.join(f.state, "active.json"), "utf8")) as ObjectValue;
    doc.padding = multibyte ? "é😀" : "x";
    const body = Buffer.from(JSON.stringify(doc));
    fs.writeFileSync(path.join(f.state, "active.json"), Buffer.concat([body, Buffer.alloc(B + delta - body.length, 32)]));
    const before = snapshot(f.root);
    for (const tracker of [false, true]) {
      const r = await call511(c, f, t, tracker ? ["--limit", "1"] : ["list", "--jsonl", "--limit", "1"], tracker);
      if (delta > 0) refused511(r, "registry_too_large", 9, tracker); else success511(r, tracker, 1);
    }
    assert.deepEqual(snapshot(f.root), before);
  });

const differentialRecords511 = (): ObjectValue[] => [
  record511("z", { dispatched_at: null, track: false, role: 1.5, keep_alive: true }),
  record511("\ue000", { dispatched_at: "tie", track: "é".repeat(256), role: [1], re_dispatch_count: 9007199254740992 }),
  record511("😀", { dispatched_at: "tie", track: "😀".repeat(257), role: { secret: "non-scalar" } }),
  record511("tab\tline\n", { dispatched_at: 12, gate: null }),
  record511("gated-object", { gate: { state: {} } }), record511("gated-list", { gate: { state: [] } }),
  record511("gated-false", { gate: { state: false } }), record511("gated-zero", { gate: { state: 0 } }),
  record511("gated-empty", { gate: { state: "" } }), record511("missing-gate", { gate: undefined }),
  ...["cleaned", "cutover_retired", "delivery_failed", "not_delivered", "superseded", "x".repeat(257)]
    .map((state, i) => record511(`lifecycle-${i}`, { lifecycle: { state } })),
];
for (const live of [false, true]) for (const limit of [1, 50, 100])
  test(`P2 actual legacy/projection differential all cursor pages live=${live} limit=${limit}`, options511, async t => {
    const c = begin("differential"), f = fixture(c, "projection", false);
    seed511(f, differentialRecords511()); const p = await publish511(c, f, t), old = legacy511(c, p);
    const before = [snapshot(f.root), snapshot(old.root)];
    let cursor: string | null = null; const ids: string[] = [];
    for (let page = 0; ; page++) {
      assert.ok(page < 30, "paging terminates");
      const flags: string[] = [...(live ? ["--live"] : []), "--limit", String(limit), ...(cursor ? ["--after", cursor] : [])];
      const legacy = success511(await call511(c, old, t, ["list", "--jsonl", ...flags]), false, 1);
      const actual = success511(await call511(c, f, t, ["list", "--jsonl", ...flags]));
      assert.deepEqual(normalized511(actual), normalized511(legacy));
      const tracker = success511(await call511(c, f, t, flags, true), true);
      assert.deepEqual(tracker.rows, actual.rows); assert.equal(tracker.matching, actual.matching);
      ids.push(...(actual.rows as ObjectValue[]).map(r => r.dispatch_id as string));
      cursor = actual.next_after as string | null; if (!cursor) break;
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, live ? 6 : 16);
    if (!live) assert.ok(ids.indexOf("\ue000") < ids.indexOf("😀"), "Python code-point tie order");
    const equal = success511(await call511(c, f, t, ["list", "--jsonl", "--since-generation", "8", ...(live ? ["--live"] : [])]));
    assert.equal(equal.unchanged, true); assert.deepEqual(equal.rows, []); assert.equal(equal.matching, ids.length);
    assert.deepEqual([snapshot(f.root), snapshot(old.root)], before);
  });

for (const [axis, value, tooLarge] of [
  ["dispatch_id", "a".repeat(256), false], ["dispatch_id", "a".repeat(257), true],
  ["dispatch_id", "é".repeat(128), false], ["dispatch_id", "é".repeat(128) + "x", true],
  ["dispatch_id", "\ud800".repeat(85), false], ["dispatch_id", "\ud800".repeat(86), true],
  ["dispatched_at", "a".repeat(128), false], ["dispatched_at", "a".repeat(129), true],
] as const) test(`P3 selected identity ${axis} length=${value.length} oversized=${tooLarge}`, options511, async t => {
  const c = begin("identity"), f = fixture(c, "projection", false);
  seed511(f, [record511("first", { dispatched_at: "" }), record511("later", { dispatched_at: "later", [axis]: value })]);
  const p = await publish511(c, f, t), old = legacy511(c, p);
  for (const state of [f, old]) {
    const version = state === f ? 2 : 1;
    const first = success511(await call511(c, state, t, ["list", "--jsonl", "--limit", "1"]), false, version);
    assert.equal((first.rows as ObjectValue[])[0]!.dispatch_id, "first");
    const selected = await call511(c, state, t, ["list", "--jsonl", "--after", first.next_after as string]);
    if (tooLarge) refused511(selected, "identity_too_large", 3); else success511(selected, false, version);
    const equal = success511(await call511(c, state, t, ["list", "--jsonl", "--since-generation", "8"]), false, version);
    assert.equal(equal.unchanged, true);
  }
});

test("P4 invalid gates retain writer validity and stale/filter precedence; hidden identity stays unselected", options511, async t => {
  const c = begin("gate-precedence"), f = fixture(c, "projection", false);
  seed511(f, [record511("ok"), record511("x".repeat(257), { gate: { state: {} } })]);
  await publish511(c, f, t);
  const live = success511(await call511(c, f, t, ["list", "--jsonl", "--live"]));
  assert.equal((live.rows as ObjectValue[]).length, 1);
  const bad = fixture(c, "invalid", false); seed511(bad, [record511("bad", { gate: false })]);
  const p = await publish511(c, bad, t);
  assert.equal((JSON.parse(p.bytes.toString()).rows as ObjectValue[])[0]!.gate_invalid, true);
  for (const flags of [[], ["--live"], ["--since-generation", "8"]])
    refused511(await call511(c, bad, t, ["list", "--jsonl", ...flags]), "registry_corrupt");
  const cursor = (generation: number, live: boolean): string => Buffer.from(ascii511([generation, "", "a", live])).toString("base64url");
  refused511(await call511(c, bad, t, ["list", "--jsonl", "--after", cursor(7, true)]), "stale_cursor", 3);
  refused511(await call511(c, bad, t, ["list", "--jsonl", "--after", cursor(8, true)]), "invalid_argument", 4);
});

test("P5 complete report/history retention, private exclusion and unchanged object reuse across generation", options511, async t => {
  const c = begin("retention-reuse"), f = fixture(c, "projection", false);
  const secret = "SYNTHETIC-REPORT-SECRET-511";
  const records = ["open", "rework_requested", "legacy_unbound"].map((resolution, index) => record511(`report-${index}`, {
    lifecycle: { state: index ? "delivery_attempt_started" : "cleaned" },
    report: { v: 1, resolution, items: Object.fromEntries(["REPORT", "HOLD", "TURN"].map(kind => [kind,
      { kind, sha256: "2".repeat(64), challenge_hash: "3".repeat(64), body: secret,
        review: { verdict: "accepted", text: secret }, notice: { text: secret }, observation: { text: secret } }])),
      failures: [], history: [{ event: "retained", text: secret }] }, observations: [{ kind: "retained", text: secret }],
  }));
  seed511(f, records); const before = JSON.parse(fs.readFileSync(path.join(f.state, "active.json"), "utf8"));
  const first = await publish511(c, f, t);
  const expected = structuredClone(before); expected.generation = 8;
  // observe updates the record selected by sid according to the existing actual helper.
  for (let i = 0; i < records.length; i++) {
    const actual = (first.doc.dispatches as ObjectValue[])[i]!;
    assert.deepEqual(actual.report, records[i]!.report);
    const oldObservations = records[i]!.observations as unknown[];
    assert.deepEqual((actual.observations as unknown[]).slice(0, oldObservations.length), oldObservations);
    if (i === 2) { // Existing find_by_sid selects the last non-retired matching record.
      const added = { kind: "synthetic-publication", at: NOW, terminal: false };
      expected.dispatches[i].observations.push(added); expected.dispatches[i].last_observation = added;
      expected.dispatches[i].last_seen_at = NOW;
    }
  }
  const actual = structuredClone(first.doc); delete actual.status_projection; assert.deepEqual(actual, expected);
  assert.ok(!first.bytes.includes(Buffer.from(secret)));
  const objectBefore = fs.lstatSync(first.object), objectHash = sha(first.bytes);
  const second = await publish511(c, f, t);
  assert.equal(second.doc.generation, 9); assert.deepEqual(second.descriptor, first.descriptor);
  const objectAfter = fs.lstatSync(second.object);
  assert.equal(second.object, first.object); assert.equal(objectAfter.ino, objectBefore.ino);
  assert.equal(objectAfter.mtimeMs, objectBefore.mtimeMs); assert.equal(sha(second.bytes), objectHash);
  const readBefore = snapshot(f.root);
  const result = await call511(c, f, t, ["--limit", "100"], true); success511(result, true);
  assert.ok(!result.stdout.includes(Buffer.from(secret))); assert.deepEqual(snapshot(f.root), readBefore);
});

// Owned synthetic corruption only. Never used to stand in for writer publication proof.
function replaceObject511(f: Fixture, p: Publication, bytes: Buffer, descriptorChanges: ObjectValue = {}): void {
  const digest = sha(bytes), name = path.basename(p.object).endsWith(".json") ? `${digest}.json` : digest;
  const object = path.join(f.state, "status-projections", name);
  fs.writeFileSync(object, bytes, { mode: 0o600 });
  const descriptor = { v: 1, sha256: digest, bytes: bytes.length, rows: p.descriptor.rows, ...descriptorChanges };
  const rest = { ...p.doc }; delete rest.schema_version; delete rest.generation; delete rest.status_projection;
  fs.writeFileSync(path.join(f.state, "active.json"), ascii511({ schema_version: 2, generation: p.doc.generation,
    status_projection: descriptor }).slice(0, -1) + ",\n" + ascii511(rest).slice(1) + "\n");
}
const objectMutants511: Array<[string, (v: { v: unknown; rows: ObjectValue[] }) => void]> = [
  ["version", v => { v.v = 2; }], ["duplicate IDs", v => { v.rows.push(structuredClone(v.rows[0]!)); }],
  ["missing field", v => { delete v.rows[0]!.track; }], ["extra field", v => { v.rows[0]!.secret = "x"; }],
  ["nested scalar", v => { v.rows[0]!.track = {}; }], ["nonboolean gated", v => { v.rows[0]!.gated = 1; }],
  ["inconsistent gate flags", v => { v.rows[0]!.gate_invalid = true; v.rows[0]!.gated = true; }],
  ["display gate contradicts flag", v => { v.rows[0]!["gate.state"] = "held"; v.rows[0]!.gated = false; }],
  ["empty ID", v => { v.rows[0]!.dispatch_id = ""; }], ["unsafe integer", v => { v.rows[0]!.track = 9007199254740992; }],
];
for (const [name, mutate] of objectMutants511)
  test(`P6 full object schema refuses ${name} even at equal generation`, options511, async t => {
    const c = begin("object-mutant"), f = fixture(c, "state", false), p = await publish511(c, f, t);
    const parsed = JSON.parse(p.bytes.toString()) as { v: unknown; rows: ObjectValue[] }; mutate(parsed);
    replaceObject511(f, p, Buffer.from(ascii511(parsed) + "\n"), { rows: parsed.rows.length });
    const before = snapshot(f.root);
    for (const flags of [["--limit", "1"], ["--since-generation", "8"]])
      refused511(await call511(c, f, t, ["list", "--jsonl", ...flags]), "registry_corrupt");
    assert.deepEqual(snapshot(f.root), before);
  });

for (const name of ["duplicate root key", "duplicate row key", "trailing bytes", "hash mismatch", "length short", "length long",
  "row count", "descriptor version", "unsafe digest", "noncanonical", "malformed prefix", "missing object"])
  test(`P7 ${name} refuses without fallback or repair`, options511, async t => {
    const c = begin("descriptor-mutant"), f = fixture(c, "state", false), p = await publish511(c, f, t);
    const active = path.join(f.state, "active.json");
    switch (name) {
      case "duplicate root key": replaceObject511(f, p, Buffer.from(p.bytes.toString().replace('{"v":1,', '{"v":1,"v":1,'))); break;
      case "duplicate row key": replaceObject511(f, p, Buffer.from(p.bytes.toString().replace('"track":', '"track":null,"track":'))); break;
      case "trailing bytes": replaceObject511(f, p, Buffer.concat([p.bytes, Buffer.from("{}\n")])); break;
      case "hash mismatch": { const b = Buffer.from(p.bytes); b[b.indexOf(Buffer.from("synthetic-track"))] = 88; fs.writeFileSync(p.object, b); break; }
      case "length short": replaceObject511(f, p, p.bytes, { bytes: p.bytes.length - 1 }); break;
      case "length long": replaceObject511(f, p, p.bytes, { bytes: p.bytes.length + 1 }); break;
      case "row count": replaceObject511(f, p, p.bytes, { rows: 2 }); break;
      case "descriptor version": replaceObject511(f, p, p.bytes, { v: 2 }); break;
      case "unsafe digest": replaceObject511(f, p, p.bytes, { sha256: "../outside" }); break;
      case "noncanonical": fs.writeFileSync(active, JSON.stringify(p.doc, null, 2) + "\n"); break;
      case "malformed prefix": fs.writeFileSync(active, fs.readFileSync(active).toString().replace('"bytes":', '"bytes":false,"extra":')); break;
      case "missing object": fs.unlinkSync(p.object); break;
    }
    const before = snapshot(f.root);
    for (const tracker of [false, true]) {
      const r = await call511(c, f, t, tracker ? [] : ["list", "--jsonl"], tracker);
      assert.equal(r.code, 9); assert.equal(r.stdout.length, 0);
      assert.match(r.stderr.toString(), /: registry_(corrupt|unavailable)\n$/);
    }
    assert.deepEqual(snapshot(f.root), before);
  });

test("P8 corruption outside selected page is verified; unread authority history is explicitly unverified", options511, async t => {
  const c = begin("integrity-scope"), f = fixture(c, "state", false);
  seed511(f, [record511("a", { observations: [{ kind: "old", padding: "HISTORY-ONLY-511" }] }), record511("z", { track: "unselected" })]);
  const p = await publish511(c, f, t), bytes = Buffer.from(p.bytes);
  bytes[bytes.indexOf(Buffer.from("unselected"))] = 88; fs.writeFileSync(p.object, bytes);
  refused511(await call511(c, f, t, ["list", "--jsonl", "--limit", "1"]), "registry_corrupt");
  fs.writeFileSync(p.object, p.bytes);
  const active = path.join(f.state, "active.json"), original = fs.readFileSync(active);
  // Break the JSON token only inside original observation history, at identical size.
  const damaged = Buffer.from(original), marker = damaged.indexOf(Buffer.from('"HISTORY-ONLY-511"'));
  assert.ok(marker > p.prefix.length); damaged[marker] = 88;
  fs.writeFileSync(active, damaged);
  const before = snapshot(f.root);
  const result = success511(await call511(c, f, t, ["--limit", "1"], true), true);
  assert.equal(result.validation, "commit-bound-projection");
  assert.deepEqual(snapshot(f.root), before, "projection status does not repair unread history");
  const writer = await call511(c, f, t, ["observe", "--sid", "synthetic-worker", "--kind", "x", "--now", NOW]);
  assert.notEqual(writer.code, 0); assert.deepEqual(fs.readFileSync(active), damaged);
  // The failed writer can touch its lock; status itself was observed before it.
  fs.writeFileSync(path.join(c.root, "pre-writer-snapshot.json"), JSON.stringify(before));
});

// Complete test-only program. runpy executes the original helper file unchanged.
// Instrumentation records explicit reads and requires unbuffered tracked streams;
// a buffered implementation fails instead of being misreported as syscall proof.
const FS_HARNESS_511 = String.raw`import builtins, errno, io, json, os, runpy, subprocess, sys, threading
helper, trace_path, fault_stage = sys.argv[1:4]
sys.argv = [helper] + sys.argv[4:]
state = os.path.abspath(os.environ["DISPATCH_STATE_DIR"])
original_open, original_io_open = builtins.open, io.open
original_os_open, original_read = os.open, os.read
original_fsync, original_replace, original_link = os.fsync, os.replace, os.link
fds = {}
trace = {"opens": [], "reads": {}, "buffered": [], "stages": [], "hit": False}
def old_reader(p):
    if fault_stage != "old-reader" or trace["hit"] or p != os.path.join(state, "active.json"):
        return
    trace["hit"] = True
    keys = ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR",
            "TMP", "TEMP", "DISPATCH_STATE_DIR", "AIGENTRY_SHIM_SCRIPT_DIR", "PATH", "LANG", "LC_ALL",
            "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE")
    env = {key: os.environ[key] for key in keys if key in os.environ}
    child = subprocess.Popen([sys.executable, helper, "observe", "--sid", "synthetic-worker", "--kind",
                              "concurrent-publication", "--now", "2026-01-03T00:00:00Z"],
                             cwd=os.path.dirname(trace_path), env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    streams, faults = [b"", b""], []
    def drain(index, stream):
        chunks, total = [], 0
        while True:
            data = stream.read(8192)
            if not data:
                break
            chunks.append(data[:max(0, 1048576-total)])
            total += len(data)
            if total > 1048576:
                faults.append("overflow")
                child.kill()
                break
        streams[index] = b"".join(chunks)
    threads = [threading.Thread(target=drain, args=(i, stream), daemon=True)
               for i, stream in enumerate((child.stdout, child.stderr))]
    for thread in threads:
        thread.start()
    try:
        code = child.wait(timeout=30)
    except subprocess.TimeoutExpired:
        faults.append("timeout")
        child.kill()
        code = child.wait(timeout=1)
    for thread in threads:
        thread.join(timeout=1)
        if thread.is_alive():
            faults.append("stream did not close")
    for i, data in enumerate(streams):
        with original_open(trace_path + ".writer-" + str(i), "wb") as receipt:
            receipt.write(data)
    trace["writer"] = {"code": code, "faults": faults, "stdout_bytes": len(streams[0]), "stderr_bytes": len(streams[1])}
    if code != 0 or faults:
        raise RuntimeError("concurrent writer failed; retained trace and streams")
def tracked(p):
    if not isinstance(p, (str, bytes, os.PathLike)):
        return fds.get(p, "") if isinstance(p, int) else ""
    p = os.path.abspath(os.fsdecode(p))
    return p if p == os.path.join(state, "active.json") or p.startswith(os.path.join(state, "status-projections") + os.sep) else ""
def stage(name):
    trace["stages"].append(name)
    if name == fault_stage and not trace["hit"]:
        trace["hit"] = True
        raise OSError(errno.EIO, "synthetic filesystem fault")
def count(p, data):
    if p:
        n = len(data.encode("utf-8")) if isinstance(data, str) else len(data)
        trace["reads"][p] = trace["reads"].get(p, 0) + n
class Stream:
    def __init__(self, stream, p):
        self.stream, self.p = stream, p
    def __getattr__(self, key):
        return getattr(self.stream, key)
    def __enter__(self):
        self.stream.__enter__()
        return self
    def __exit__(self, *args):
        return self.stream.__exit__(*args)
    def read(self, *args):
        data = self.stream.read(*args)
        count(self.p, data)
        return data
    def readline(self, *args):
        data = self.stream.readline(*args)
        count(self.p, data)
        return data
    def readinto(self, buf):
        n = self.stream.readinto(buf)
        count(self.p, memoryview(buf)[:n])
        return n
    def write(self, data):
        if self.p:
            stage("projection-write" if "status-projections" in self.p else "authority-write")
        return self.stream.write(data)
def opened(original, file, *args, **kwargs):
    stream = original(file, *args, **kwargs)
    p = tracked(file)
    # Also track authority temporary streams for publication fault stages.
    actual = os.path.abspath(os.fsdecode(file)) if isinstance(file, (str, bytes, os.PathLike)) else fds.get(file, "")
    if actual.startswith(os.path.join(state, "active.json.")):
        p = actual
    if p:
        fds[stream.fileno()] = p
        old_reader(p)
        mode = args[0] if args else kwargs.get("mode", "r")
        trace["opens"].append({"path": p, "mode": mode})
        if "r" in mode and not isinstance(stream, io.FileIO):
            trace["buffered"].append(p)
        return Stream(stream, p)
    return stream
def os_open(file, flags, *args, **kwargs):
    fd = original_os_open(file, flags, *args, **kwargs)
    p = os.path.abspath(os.fsdecode(file))
    fds[fd] = p
    old_reader(p)
    if tracked(file):
        trace["opens"].append({"path": p, "flags": flags})
    return fd
def read(fd, n):
    data = original_read(fd, n)
    count(tracked(fds.get(fd, "")), data)
    return data
def fsync(fd):
    p = fds.get(fd, "")
    if p == state:
        stage("authority-dir-fsync")
    elif p == os.path.join(state, "status-projections"):
        stage("projection-dir-fsync")
    elif p.startswith(os.path.join(state, "status-projections") + os.sep):
        stage("projection-fsync")
    elif p.startswith(os.path.join(state, "active.json.")):
        stage("authority-fsync")
    return original_fsync(fd)
def replace(src, dst, *args, **kwargs):
    p = os.path.abspath(os.fsdecode(dst))
    if p == os.path.join(state, "active.json"):
        stage("authority-replace")
    elif p.startswith(os.path.join(state, "status-projections") + os.sep):
        stage("projection-install")
    return original_replace(src, dst, *args, **kwargs)
def link(src, dst, *args, **kwargs):
    if os.path.abspath(os.fsdecode(dst)).startswith(os.path.join(state, "status-projections") + os.sep):
        stage("projection-install")
    return original_link(src, dst, *args, **kwargs)
builtins.open = lambda file, *args, **kwargs: opened(original_open, file, *args, **kwargs)
io.open = lambda file, *args, **kwargs: opened(original_io_open, file, *args, **kwargs)
os.open, os.read, os.fsync, os.replace, os.link = os_open, read, fsync, replace, link
try:
    runpy.run_path(helper, run_name="__main__")
finally:
    with original_open(trace_path, "w", encoding="ascii") as output:
        json.dump(trace, output, ensure_ascii=True, sort_keys=True)
        output.write("\n")
`;
async function instrument511(c: Case, f: Fixture, t: Diagnostic, args: string[], stage = "none"):
Promise<{ result: Receipt; trace: { opens: Array<{ path: string }>; reads: Record<string, number>; buffered: string[]; hit: boolean; stages: string[] } }> {
  const script = path.join(c.root, "filesystem-harness.py"), tracePath = path.join(c.root, `trace-${c.sequence}.json`);
  fs.writeFileSync(script, FS_HARNESS_511, { mode: 0o600 });
  const result = await call511(c, f, t, args, false, script, [helper, tracePath, stage]);
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  t.diagnostic(JSON.stringify({ tracePath, sha256: sha(fs.readFileSync(tracePath)), hit: trace.hit, reads: trace.reads }));
  return { result, trace };
}

for (const delta of [-1, 0, 1]) test(`P9 cumulative actual prefix plus object bytes B${delta < 0 ? "-1" : delta ? "+1" : ""}`, options511, async t => {
  const c = begin("combined-budget"), f = fixture(c, "state", false), p = await publish511(c, f, t);
  const object = JSON.parse(p.bytes.toString()) as { v: number; rows: ObjectValue[] };
  object.rows[0]!.track = "é";
  let bytes = Buffer.from(ascii511(object) + "\n"), target = B + delta - p.prefix.length;
  // Prefix length changes when byte-count digits change. Solve using actual bytes.
  for (let attempt = 0; attempt < 4; attempt++) {
    object.rows[0]!.track = "é" + "x".repeat(Math.max(0, target - bytes.length));
    bytes = Buffer.from(ascii511(object) + "\n");
    replaceObject511(f, p, bytes);
    const actual = fs.readFileSync(path.join(f.state, "active.json"));
    const prefixLength = actual.indexOf(10) + 1;
    if (prefixLength + bytes.length === B + delta) break;
    target = B + delta - prefixLength;
    object.rows[0]!.track = "é"; bytes = Buffer.from(ascii511(object) + "\n");
  }
  const active = fs.readFileSync(path.join(f.state, "active.json")), prefixLength = active.indexOf(10) + 1;
  assert.equal(prefixLength + bytes.length, B + delta, "actual encoded cumulative boundary");
  const before = snapshot(f.root);
  const { result, trace } = await instrument511(c, f, t, ["list", "--jsonl", "--since-generation", "8"]);
  if (delta > 0) refused511(result, "registry_too_large"); else {
    const value = success511(result); assert.equal(value.unchanged, true);
    assert.equal(Object.values(trace.reads).reduce((a, b) => a + b, 0), B + delta);
  }
  assert.deepEqual(trace.buffered, [], "no hidden buffered prefetch accepted as accounted reads");
  assert.ok(Object.values(trace.reads).reduce((a, b) => a + b, 0) <= B + 1);
  assert.equal(trace.opens.filter(o => o.path === path.join(f.state, "active.json")).length, 1);
  const objectOpens = trace.opens.filter(o => o.path.includes("status-projections"));
  assert.ok(objectOpens.length <= 1, "no projection reopen or fallback");
  assert.deepEqual(snapshot(f.root), before);
});

test("P10 actual writer preserves a single over-budget status string and bounded readers refuse", options511, async t => {
  const c = begin("large-status-field"), f = fixture(c, "state", false);
  const huge = "é".repeat(Math.ceil(B / 6)); seed511(f, [record511("large", { track: huge })]);
  const p = await publish511(c, f, t);
  assert.ok(p.bytes.length > B); assert.equal((p.doc.dispatches as ObjectValue[])[0]!.track, huge);
  const before = snapshot(f.root);
  for (const flags of [["--limit", "1"], ["--live"], ["--since-generation", "8"]])
    refused511(await call511(c, f, t, ["list", "--jsonl", ...flags]), "registry_too_large");
  assert.deepEqual(snapshot(f.root), before);
});

for (const stage of ["projection-write", "projection-fsync", "projection-install", "projection-dir-fsync",
  "authority-write", "authority-fsync", "authority-replace", "authority-dir-fsync"])
  test(`P11 simulated actual writer filesystem fault ${stage} preserves publication boundary`, options511, async t => {
    const c = begin("writer-fault"), f = fixture(c, "state", false);
    const active = path.join(f.state, "active.json"), old = fs.readFileSync(active);
    const { result, trace } = await instrument511(c, f, t,
      ["observe", "--sid", "synthetic-worker", "--kind", "synthetic-publication", "--now", NOW], stage);
    assert.equal(trace.hit, true, `required filesystem interception was reached: ${stage}`);
    assert.notEqual(result.code, 0, "fault must be reported");
    if (stage === "authority-dir-fsync") {
      const p = publication511(f); assert.equal(p.doc.generation, 8); preserve(f);
    } else assert.deepEqual(fs.readFileSync(active), old, "pre-replace failure leaves exact old authority current");
    fs.writeFileSync(path.join(c.root, "residual-files.json"), JSON.stringify(snapshot(f.root), null, 2));
    t.diagnostic("Simulated I/O error only; residual objects retained. This is not native crash durability evidence.");
  });

test("P12 existing digest corruption refuses writer reuse and keeps authority unchanged", options511, async t => {
  const c = begin("reuse-corrupt"), f = fixture(c, "state", false), p = await publish511(c, f, t);
  const damaged = Buffer.from(p.bytes); damaged[damaged.length - 1] = 32; fs.writeFileSync(p.object, damaged);
  const active = fs.readFileSync(path.join(f.state, "active.json"));
  const r = await call511(c, f, t, ["observe", "--sid", "synthetic-worker", "--kind", "synthetic-publication", "--now", NOW]);
  assert.notEqual(r.code, 0); assert.deepEqual(fs.readFileSync(path.join(f.state, "active.json")), active);
  assert.deepEqual(fs.readFileSync(p.object), damaged, "no repair of corrupt immutable object");
});

test("P13 reader pinned to old active inode uses old object during actual concurrent publication", options511, async t => {
  const c = begin("old-reader"), f = fixture(c, "state", false), old = await publish511(c, f, t);
  const { result, trace } = await instrument511(c, f, t, ["list", "--jsonl"], "old-reader");
  assert.equal(trace.hit, true); const value = success511(result);
  assert.equal(value.generation, 8); assert.equal((value.rows as ObjectValue[])[0]!["last_observation.kind"], "synthetic-publication");
  const current = publication511(f); assert.equal(current.doc.generation, 9);
  assert.notEqual(current.descriptor.sha256, old.descriptor.sha256);
  assert.deepEqual(fs.readFileSync(old.object), old.bytes, "old immutable object remains available");
  assert.equal(trace.opens.filter(o => o.path === path.join(f.state, "active.json")).length, 1);
  assert.ok(trace.opens.some(o => o.path === old.object));
  assert.ok(!trace.opens.some(o => o.path === current.object));
});

test("P14 two actual concurrent writers serialize and retain both observations", options511, async t => {
  const c = begin("concurrent-writers"), f = fixture(c, "state", false); await publish511(c, f, t);
  const results = await Promise.all(["writer-a", "writer-b"].map(kind => call511(c, f, t,
    ["observe", "--sid", "synthetic-worker", "--kind", kind, "--now", NOW])));
  for (const r of results) assert.equal(r.code, 0, r.stderr.toString());
  const p = publication511(f); assert.equal(p.doc.generation, 10);
  const observations = (p.doc.dispatches as ObjectValue[])[0]!.observations as ObjectValue[];
  assert.deepEqual(new Set(observations.slice(-2).map(o => o.kind)), new Set(["writer-a", "writer-b"]));
  assert.equal(observations.length, f.original.dispatches[0]!.observations.length + 3);
});

for (const kind of ["object symlink", "object directory", "parent symlink"])
  test(`P15 unsafe projection path ${kind} refuses without following or repairing owned target`, options511, async t => {
    const c = begin("unsafe-path"), f = fixture(c, "state", false), p = await publish511(c, f, t);
    const target = path.join(c.root, "owned-target"), dir = path.dirname(p.object);
    if (kind === "parent symlink") {
      fs.renameSync(dir, target); fs.symlinkSync(target, dir, "dir");
    } else {
      fs.unlinkSync(p.object);
      if (kind === "object directory") fs.mkdirSync(p.object);
      else { fs.writeFileSync(target, p.bytes); fs.symlinkSync(target, p.object); }
    }
    const active = fs.readFileSync(path.join(f.state, "active.json"));
    const targetBefore = kind === "object symlink" ? fs.readFileSync(target) : null;
    const { result, trace } = await instrument511(c, f, t, ["list", "--jsonl"]);
    assert.equal(result.code, 9); assert.equal(result.stdout.length, 0);
    assert.ok(Object.entries(trace.reads).every(([p, bytes]) => !p.includes("status-projections") || bytes === 0));
    assert.deepEqual(fs.readFileSync(path.join(f.state, "active.json")), active);
    if (targetBefore) assert.deepEqual(fs.readFileSync(target), targetBefore);
    if (kind !== "object directory") assert.ok(fs.lstatSync(kind === "parent symlink" ? dir : p.object).isSymbolicLink());
  });

test("P16 ASCII escape expansion obeys output cap and preserves the complete small-page oracle", options511, async t => {
  const c = begin("output-bound"), f = fixture(c, "state", false);
  const records = Array.from({ length: 100 }, (_, i) => record511(`row-${String(i).padStart(3, "0")}`, {
    assigned: { sid: i === 99 ? "synthetic-worker" : "\u0001".repeat(256) },
    track: "\u0001".repeat(256), role: "\u0001".repeat(256), lifecycle: { state: "\u0001".repeat(256), at: "\u0001".repeat(256) },
    gate: { state: "\u0001".repeat(256) }, transport: { result: "\u0001".repeat(256), at: "\u0001".repeat(256) },
    expected_report_by: "\u0001".repeat(256), last_seen_at: "\u0001".repeat(256),
    last_observation: { kind: "\u0001".repeat(256), at: "\u0001".repeat(256) },
  }));
  seed511(f, records); const p = await publish511(c, f, t), old = legacy511(c, p);
  for (const state of [f, old]) for (const tracker of [false, true]) {
    const args = ["--limit", "100"];
    refused511(await call511(c, state, t, tracker ? args : ["list", "--jsonl", ...args], tracker), "output_too_large", 3, tracker);
  }
  const actual = success511(await call511(c, f, t, ["list", "--jsonl", "--limit", "10"]));
  const legacy = success511(await call511(c, old, t, ["list", "--jsonl", "--limit", "10"]), false, 1);
  assert.deepEqual(normalized511(actual), normalized511(legacy));
  assert.equal((actual.rows as ObjectValue[])[0]!.track, "\u0001".repeat(256));
});

test("P17 separately admitted old compiled tracker explicitly refuses new helper v2", options511, async t => {
  const oldCli = process.env.AIGENTRY_STATUS_TEST_OLD_CLI, pin = process.env.AIGENTRY_STATUS_TEST_OLD_CLI_SHA256;
  assert.ok(oldCli && path.isAbsolute(oldCli), "root must admit retained old compiled tracker closure");
  assert.equal(fs.realpathSync(oldCli), oldCli); assert.ok(fs.lstatSync(oldCli).isFile());
  assert.match(pin ?? "", /^[a-f0-9]{64}$/); assert.equal(sha(fs.readFileSync(oldCli)), pin);
  const c = begin("old-tracker"), f = fixture(c, "state", false); await publish511(c, f, t);
  const r = await run(c, f, "old-tracker", process.execPath, [oldCli, "status", "--json"], 10_000);
  t.diagnostic(c.diagnostics[c.diagnostics.length - 1]!); clean(r);
  refused511(r, "malformed_output", 3, true);
});
