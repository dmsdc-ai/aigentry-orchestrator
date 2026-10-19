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
interface Case { root: string; python: string; pythonBin: string; deadline: number; sequence: number }
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
  return { root, python, pythonBin, deadline: Date.now() + 110_000, sequence: 0 };
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
  return { code, signal, faults, stdout, stderr };
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
