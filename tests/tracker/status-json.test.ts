import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// #1172 `dispatch-tracker status --json` regression. Runs the actual tsc output of
// src/tracker/cli.ts against the actual bin/dispatch-registry.py on private synthetic
// state under a temp root: no host registry, daemon, network, shell or product edits.
// Fake backends are confined to the DISPATCH_REGISTRY_PY seam. Platform-neutral
// (win32 runs the registry via `python`); only the bash shim caller check is POSIX.
const self = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(self), "..", "..", "..");
const cli = path.join(repoRoot, "dist", "src", "tracker", "cli.js");
const binDir = path.join(repoRoot, "bin");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "status-json-"));
after(() => fs.rmSync(output, { recursive: true, force: true }));

const CANARY = "CANARY-SECRET-1172-zq9";
const WALL_MS = 60_000;
const READ_CAP = 32 * 1024 * 1024;
const SEAMS = ["DISPATCH_REGISTRY_PY", "AIGENTRY_REGISTRY_FAULT", "DISPATCH_STATE_DIR", "AIGENTRY_SHIM_SCRIPT_DIR",
  "TRACKER_NOW", "DISPATCH_SH", "SESSION_PROBE_PY", "POLICY_PY", "HITL_SH", "FAKE1172_MODE", "FAKE1172_LOG"];
const WHITELIST = ["dispatch_id", "assigned.sid", "track", "role", "lifecycle.state", "lifecycle.at", "gate.state",
  "outcome.state", "transport.result", "transport.at", "dispatched_at", "expected_report_by", "last_seen_at",
  "re_dispatch_count", "keep_alive", "last_observation.kind", "last_observation.at", "dedup.ref_hash"];
const FORBIDDEN_KEYS = ["observations", "cwd", "ref_path", "branch", "worktree", "from_sid", "inject_id", "capability"];
const ENVELOPE_KEYS = ["v", "generation", "unchanged", "rows", "more", "next_after", "matching", "oversize", "evidence",
  "completion_fact", "read_bound_bytes", "scan"];
const REASONS = new Set(["invalid_argument", "stale_cursor", "identity_too_large", "output_too_large", "malformed_output",
  "registry_corrupt", "registry_unavailable", "registry_too_large", "registry_error"]);

type Rec = Record<string, unknown>;
type Row = Record<string, unknown>;
interface Run { code: number | null; stdout: string; stderr: string }
interface Envelope { generation: number; rows: Row[]; more: boolean; next_after: string | null; matching: number; oversize: number }

const rec = (id: string, sid: string, over: Rec = {}): Rec => ({
  dispatch_id: id, assigned: { sid }, dedup: { key: `k-${id}`, ref_hash: "0".repeat(64) },
  outcome: { state: "unknown", reported_value: null }, lifecycle: { state: "attempt_started" }, ...over,
});
const registry = (generation: unknown, dispatches: Rec[]) => ({ schema_version: 2, generation, dispatches });

// Records A-D equal output/ownedfixture/seed/active.json of the pre-change baseline in every
// legacy-visible column, so the legacy byte pins below were measured on exactly these values.
const A = rec("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fx-alpha", {
  track: "fx", role: "coder", cwd: `/fake/cwd/${CANARY}`, ref_path: `/fake/ref/${CANARY}.md`, branch: CANARY,
  worktree: CANARY, from_sid: CANARY, capability: { token: CANARY },
  dedup: { key: "k-a", ref_hash: "1".repeat(64) },
  lifecycle: { state: "delivery_state_unknown", at: "2026-10-01T00:00:10Z" }, gate: { state: null },
  transport: { result: "unknown", at: "2026-10-01T00:00:05Z", inject_id: CANARY },
  dispatched_at: "2026-10-01T00:00:00Z", expected_report_by: "2026-10-01T01:00:00Z",
  last_seen_at: "2026-10-01T00:00:20Z", re_dispatch_count: 0, keep_alive: false,
  last_observation: { kind: "screen", at: "2026-10-01T00:00:20Z", terminal: false, text: CANARY },
  observations: [{ kind: "screen", at: "2026-10-01T00:00:20Z", text: CANARY }],
});
const B = rec("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "fx-bravo", {
  track: "fx", role: "tester", lifecycle: { state: "superseded", at: "2026-10-01T00:05:00Z" },
  dispatched_at: "2026-10-01T00:01:00Z", expected_report_by: "2026-10-01T01:01:00Z", re_dispatch_count: 1, observations: [],
});
const C = rec("legacy-id:C/é☃", "fx-char\tlie\nx", {
  track: "T" + "x".repeat(299), role: "coder", lifecycle: { state: "attempt_started", at: "2026-10-01T00:02:30Z" },
  gate: { state: "held" }, dispatched_at: "2026-10-01T00:02:00Z", expected_report_by: "2026-10-01T01:02:00Z",
  re_dispatch_count: 0, observations: [{ kind: "env", at: "2026-10-01T00:02:40Z", text: `TOKEN=${CANARY}` }],
});
const D = rec("dddddddddddddddddddddddddddddddd", "fx-delta", { re_dispatch_count: 2, observations: [] });
const BASE = [A, B, C, D];

let seq = 0;
function stateDir(content: unknown): string {
  const dir = path.join(output, `s${++seq}`);
  fs.mkdirSync(dir);
  if (content !== null) {
    const bytes = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + "\n";
    fs.writeFileSync(path.join(dir, "active.json"), bytes);
  }
  return dir;
}

function run(cmd: string, args: string[], state: string, extra: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SEAMS) delete env[key];
  Object.assign(env, { DISPATCH_STATE_DIR: state, AIGENTRY_SHIM_SCRIPT_DIR: binDir }, extra);
  const r = spawnSync(cmd, args, { env, encoding: "utf8", shell: false, timeout: WALL_MS, maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const tracker = (state: string, args: string[], extra: Record<string, string> = {}) =>
  run(process.execPath, [cli, ...args], state, extra);
const statusJson = (state: string, ...flags: string[]) => tracker(state, ["status", "--json", ...flags]);

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** Every file in the state dir with its digest; status must leave it exactly as found. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) out[name] = sha(fs.readFileSync(path.join(dir, name)));
  return out;
}
function noCanary(r: Run): void {
  assert.ok(!r.stdout.includes(CANARY), "canary leaked to stdout");
  assert.ok(!r.stderr.includes(CANARY), "canary leaked to stderr");
}
/** Every new-mode failure: exact exit, EMPTY stdout, one fixed nonsensitive stderr line naming the reason. */
function refused(r: Run, code: number, why: string, reason: string): void {
  assert.ok(REASONS.has(reason));
  assert.equal(r.code, code, `${why}: exit ${r.code}, stderr ${r.stderr}`);
  assert.equal(r.stdout, "", `${why}: stdout must be empty`);
  assert.equal(r.stderr, `dispatch-tracker: status --json: ${reason}\n`, `${why}: fixed stderr`);
  noCanary(r);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Rows are flat dotted keys: exactly the 18 whitelist keys, scalars only. */
function flatRow(row: unknown): Row {
  assert.ok(isObject(row), "row is an object");
  assert.deepEqual(Object.keys(row).sort(), [...WHITELIST].sort(), "row keys are exactly the whitelist");
  for (const [key, item] of Object.entries(row)) {
    assert.ok(item === null || ["string", "number", "boolean"].includes(typeof item), `non-scalar at ${key}`);
  }
  return row;
}

function parseEnvelope(r: Run, isUnchanged: boolean): Record<string, unknown> {
  assert.equal(r.code, 0, `exit ${r.code}, stderr ${r.stderr}`);
  assert.equal(r.stderr, "", "success writes nothing to stderr");
  noCanary(r);
  for (const key of FORBIDDEN_KEYS) assert.ok(!r.stdout.includes(`"${key}"`), `forbidden key ${key} emitted`);
  assert.ok(r.stdout.endsWith("}\n") && r.stdout.indexOf("\n") === r.stdout.length - 1, "one JSON line");
  const v: unknown = JSON.parse(r.stdout);
  assert.ok(isObject(v), "one JSON object");
  assert.deepEqual(Object.keys(v).sort(), [...ENVELOPE_KEYS].sort(), "envelope keys are exactly the documented set");
  assert.equal(v.v, 1);
  assert.equal(v.unchanged, isUnchanged);
  assert.equal(v.evidence, "registry-observation");
  assert.equal(v.completion_fact, null);
  assert.equal(v.read_bound_bytes, READ_CAP);
  assert.equal(v.scan, "full", "an unchanged generation still reads the whole registry");
  assert.ok(Number.isSafeInteger(v.generation) && (v.generation as number) >= 0);
  assert.ok(Number.isSafeInteger(v.matching) && (v.matching as number) >= 0);
  assert.ok(Number.isSafeInteger(v.oversize) && (v.oversize as number) >= 0);
  assert.equal(typeof v.more, "boolean");
  assert.ok(Array.isArray(v.rows));
  assert.ok((v.rows as unknown[]).length <= (v.matching as number));
  if (v.more) {
    assert.equal(typeof v.next_after, "string");
    const cursor = v.next_after as string;
    assert.match(cursor, /^[A-Za-z0-9_-]+$/, "cursor is unpadded base64url");
    assert.ok(Buffer.byteLength(cursor) <= 2048, "cursor bounded to 2048 bytes");
  } else assert.equal(v.next_after, null);
  return v;
}
function envelope(r: Run): Envelope {
  const v = parseEnvelope(r, false);
  return { ...(v as unknown as Envelope), rows: (v.rows as unknown[]).map(flatRow) };
}
function unchanged(r: Run, generation: number): void {
  const v = parseEnvelope(r, true);
  assert.equal(v.generation, generation);
  assert.deepEqual(v.rows, []);
  assert.equal(v.more, false);
  assert.equal(v.oversize, 0);
}

// ── independent oracle ─────────────────────────────────────────────────────
const RETIRED = new Set(["cleaned", "cutover_retired", "delivery_failed", "not_delivered", "superseded"]);
const points = (s: string) => Array.from(s, c => c.codePointAt(0)!);
/** Python str ordering: by code point, not UTF-16 unit. */
function cmp(a: string, b: string): number {
  const x = points(a), y = points(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
const at = (r: Rec) => (typeof r.dispatched_at === "string" ? r.dispatched_at : "");
const ordered = (recs: Rec[]) => [...recs].sort((x, y) => cmp(at(x), at(y)) || cmp(x.dispatch_id as string, y.dispatch_id as string));
function live(r: Rec): boolean {
  const gate = r.gate;
  return !RETIRED.has((r.lifecycle as Rec).state as string) && !(isObject(gate) && gate.state !== null && gate.state !== undefined);
}
function project(r: Rec): { row: Row; oversize: number } {
  const row: Row = {};
  let oversize = 0;
  for (const p of WHITELIST) {
    let cur: unknown = r;
    for (const part of p.split(".")) cur = isObject(cur) ? cur[part] : undefined;
    if (typeof cur === "string" && points(cur).length > 256) { oversize++; cur = null; }
    if (!(typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean")) cur = null;
    row[p] = cur;
  }
  return { row, oversize };
}
function pageAll(state: string, ...flags: string[]): { ids: string[]; pages: Envelope[] } {
  const pages: Envelope[] = [];
  let cursor: string | null = null;
  do {
    const page = envelope(statusJson(state, ...flags, ...(cursor === null ? [] : ["--after", cursor])));
    pages.push(page);
    cursor = page.next_after;
    assert.ok(pages.length <= 1000, "paging terminates");
  } while (cursor !== null);
  return { ids: pages.flatMap(p => p.rows.map(row => row.dispatch_id as string)), pages };
}

interface FakeSpec {
  stdout?: string | Buffer; stderr?: string; rc?: number; kill?: boolean; sleepSeconds?: number; ignoreTerm?: boolean;
  /** Survive a closed pipe (EPIPE) and keep running, so only a signal can end the process early. */
  survivePipe?: boolean;
}
/** DISPATCH_REGISTRY_PY seam: replays exact stdout/stderr bytes and exit code, logging each call. */
function fakeBackend(spec: FakeSpec): { env: Record<string, string>; log: string; dir: string } {
  const dir = path.join(output, `fake${++seq}`);
  fs.mkdirSync(dir);
  const script = path.join(dir, "fake-registry.py");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "stdout.bin"), spec.stdout ?? "");
  fs.writeFileSync(path.join(dir, "stderr.bin"), spec.stderr ?? "");
  fs.writeFileSync(path.join(dir, "rc"), String(spec.rc ?? 0));
  if (spec.kill) fs.writeFileSync(path.join(dir, "kill"), "");
  if (spec.sleepSeconds !== undefined) fs.writeFileSync(path.join(dir, "sleep"), String(spec.sleepSeconds));
  if (spec.ignoreTerm) fs.writeFileSync(path.join(dir, "ignore-term"), "");
  if (spec.survivePipe) fs.writeFileSync(path.join(dir, "survive-pipe"), "");
  fs.writeFileSync(script, [
    "#!/usr/bin/env python3",
    "import os, sys",
    "d = os.path.dirname(os.path.abspath(__file__))",
    "if os.path.exists(os.path.join(d, \"ignore-term\")):",
    "    import signal",
    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
    "with open(os.path.join(d, \"pid\"), \"w\", encoding=\"ascii\") as fh:",
    "    fh.write(str(os.getpid()))",
    "with open(os.environ[\"FAKE1172_LOG\"], \"a\", encoding=\"utf-8\") as fh:",
    "    fh.write(repr(sys.argv[1:]) + \"\\n\")",
    "for name, stream in ((\"stdout.bin\", sys.stdout), (\"stderr.bin\", sys.stderr)):",
    "    with open(os.path.join(d, name), \"rb\") as fh:",
    "        data = fh.read()",
    "    try:",
    "        stream.buffer.write(data)",
    "        stream.buffer.flush()",
    "    except OSError:",
    "        if not os.path.exists(os.path.join(d, \"survive-pipe\")):",
    "            raise",
    "if os.path.exists(os.path.join(d, \"sleep\")):",
    "    import time",
    "    with open(os.path.join(d, \"sleep\"), encoding=\"ascii\") as fh:",
    "        time.sleep(float(fh.read()))  # finite: settles by itself, spawns nothing",
    "if os.path.exists(os.path.join(d, \"survive-pipe\")):",
    "    os._exit(0)",
    "if os.path.exists(os.path.join(d, \"kill\")):",
    "    import signal",
    "    os.kill(os.getpid(), signal.SIGKILL)",
    "with open(os.path.join(d, \"rc\"), encoding=\"ascii\") as fh:",
    "    sys.exit(int(fh.read()))",
    "",
  ].join("\n"), { mode: 0o755 });
  return { env: { DISPATCH_REGISTRY_PY: script, FAKE1172_LOG: log }, log, dir };
}
const registryPy = path.join(binDir, "dispatch-registry.py");
/** The actual registry, invoked as the tracker does (shebang on POSIX, `python` on win32). */
const registryDirect = (state: string, args: string[]) => process.platform === "win32"
  ? run("python", [registryPy, ...args], state, { PYTHONIOENCODING: "utf-8" })
  : run(registryPy, args, state);
/** Raw Python text-mode lines end with the native EOL (CRLF on win32); `list --jsonl` writes LF bytes itself. */
const PY_EOL = process.platform === "win32" ? "\r\n" : "\n";
/** A well-formed `list --jsonl` stream with one row, for parser discrimination. */
function jsonlRow(over: Rec = {}): Rec {
  return { ...Object.fromEntries(WHITELIST.map(k => [k, null])), dispatch_id: "fake-1", "assigned.sid": "s", ...over };
}
function jsonlStream(header: Rec = {}, rows: Rec[] = [jsonlRow()]): string {
  const h = { v: 1, generation: 7, unchanged: false, matching: rows.length, oversize: 0, more: false, next_after: null,
    rows: rows.length, ...header };
  return [h, ...rows].map(x => JSON.stringify(x) + "\n").join("");
}

// ── tests ──────────────────────────────────────────────────────────────────
test("S1 status --json emits the whitelisted projection in (dispatched_at, dispatch_id) order", () => {
  const state = stateDir(registry(7, BASE));
  const before = snapshot(state);
  const page = envelope(statusJson(state));
  const expected = ordered(BASE).map(project);
  assert.equal(page.generation, 7);
  assert.equal(page.matching, 4);
  assert.equal(page.more, false);
  assert.deepEqual(page.rows, expected.map(e => e.row));
  assert.equal(page.oversize, 1, "the 300-char track is nulled and counted");
  const c = page.rows.find(row => row.dispatch_id === C.dispatch_id)!;
  assert.equal(c["assigned.sid"], "fx-char\tlie\nx", "TAB/LF cannot shift fields");
  assert.equal(c.role, "coder");
  assert.equal(c.track, null);
  assert.deepEqual(snapshot(state), before, "status never writes the registry or state dir");
});

test("S2 legacy status / status <sid> / unknown-flag-as-sid stay byte-identical to the pre-change baseline", () => {
  const state = stateDir(registry(7, BASE));
  const before = snapshot(state);
  // win32: the registry writes CRLF in text mode and the unchanged legacy formatter splits on LF and strips
  // only LF, so a CR stays at the end of each column read (padded in place, extra byte in the last one).
  // win32 pins: pre-change ef40fdf registry + formatter under a TextIOWrapper(newline="\r\n") simulation,
  // "status" length 582 matching native Windows CI; exact bytes, no normalization.
  const win32 = process.platform === "win32";
  const pins: Array<[string[], string, number, string, number]> = [
    [["status"], "983e42501ebaf2c5dcb1e4e75ba5cfa727e770bf6d8dd45017451933430ccdac", 578,
      "af0166d338d02501c4b89a8ed9b813d527077af751ab40023c22c2ce55992a8d", 582],
    [["status", "fx-alpha"], "3ca69e73adba7a133c6b772fd25ab9df92c4ace881fa468dbf85de65ac3122b9", 117,
      "029dce13ca383739addfdb62c381811f274ffcbabb88b4c30fe1574ad5d552c9", 118],
    [["status", "--definitely-absent"], "09695c8dd86460309c47f2108d7d252b4df76c6756fbe934d1f90852bf196d31", 97,
      "8a6035bd91fa7c1c8f5052eb5f8056e23228a850d81d557bf28e58f90897bc20", 98],
  ];
  for (const [args, posixDigest, posixBytes, winDigest, winBytes] of pins) {
    const [digest, bytes] = win32 ? [winDigest, winBytes] : [posixDigest, posixBytes];
    const r = tracker(state, args);
    assert.equal(r.code, 0, args.join(" "));
    assert.equal(r.stderr, "");
    assert.equal(Buffer.byteLength(r.stdout), bytes, args.join(" "));
    assert.equal(sha(r.stdout), digest, args.join(" "));
  }
  assert.deepEqual(snapshot(state), before);
  const corrupt = stateDir("{\"schema_version\": 2, \"generation\": 7, \"dispatches\": [");
  const r = tracker(corrupt, ["status"]);
  assert.equal(r.code, 9, "legacy status keeps pipefail on a corrupt registry");
  assert.match(r.stdout, /registry_corrupt/);
});

test("S3 --live filters retired and gated records exactly like the legacy list filter", () => {
  const state = stateDir(registry(7, BASE));
  const page = envelope(statusJson(state, "--live"));
  assert.deepEqual(page.rows, ordered(BASE.filter(live)).map(r => project(r).row));
  assert.equal(page.matching, 2);
});

test("S4 --limit 1 paging yields every id exactly once, in order, from a fixed generation", () => {
  const state = stateDir(registry(7, BASE));
  for (const flags of [[], ["--live"]]) {
    const want = ordered(flags.length ? BASE.filter(live) : BASE).map(r => r.dispatch_id);
    const { ids, pages } = pageAll(state, "--limit", "1", ...flags);
    assert.deepEqual(ids, want);
    assert.equal(pages.length, want.length);
    for (const p of pages) { assert.equal(p.generation, 7); assert.equal(p.matching, want.length); }
  }
});

test("S5 default limit 50, max 100, deterministic bytes across identical calls", () => {
  const recs = Array.from({ length: 120 }, (_, i) => rec(`id-${String(i).padStart(3, "0")}`, `s${i}`, { dispatched_at: "2026-10-01T00:00:00Z" }));
  const state = stateDir(registry(3, recs));
  const first = statusJson(state);
  const page = envelope(first);
  assert.equal(page.rows.length, 50);
  assert.equal(page.more, true);
  assert.equal(page.matching, 120);
  assert.equal(statusJson(state).stdout, first.stdout, "same snapshot, same bytes");
  assert.equal(envelope(statusJson(state, "--limit", "100")).rows.length, 100);
  const { ids } = pageAll(state, "--limit", "100");
  assert.deepEqual(ids, ordered(recs).map(r => r.dispatch_id));
});

test("S6 --since-generation: equal -> unchanged, anything else -> rows; equality never skips the read", () => {
  const state = stateDir(registry(7, BASE));
  unchanged(statusJson(state, "--since-generation", "7"), 7);
  assert.equal(envelope(statusJson(state, "--since-generation", "6")).rows.length, 4);
  assert.equal(envelope(statusJson(state, "--since-generation", "8")).rows.length, 4);
  unchanged(statusJson(stateDir(registry(0, [])), "--since-generation", "0"), 0);
  const corrupt = stateDir("{\"schema_version\": 2, \"generation\": 7, \"dispatches\": [");
  const r = statusJson(corrupt, "--since-generation", "7");
  refused(r, 9, "a corrupt registry is reported even when the caller claims generation 7", "registry_corrupt");
});

test("S7 a cursor is bound to its generation: a changed registry is a stale-cursor error, not a skip", () => {
  const state = stateDir(registry(7, BASE));
  const first = envelope(statusJson(state, "--limit", "1"));
  const cursor = first.next_after!;
  assert.equal(envelope(statusJson(state, "--limit", "1", "--after", cursor)).rows[0]!.dispatch_id, ordered(BASE)[1]!.dispatch_id);
  fs.writeFileSync(path.join(state, "active.json"), JSON.stringify(registry(8, BASE), null, 2) + "\n");
  refused(statusJson(state, "--limit", "1", "--after", cursor), 3, "stale cursor", "stale_cursor");
  assert.equal(envelope(statusJson(state, "--limit", "1")).generation, 8, "restart from the first page works");
});

test("S8 malformed or tampered cursors and --after with --since-generation are refused (exit 4)", () => {
  const state = stateDir(registry(7, BASE));
  const cursor = envelope(statusJson(state, "--limit", "1")).next_after!;
  const bad = ["", "!!!!", "A".repeat(3000), `${cursor}A`, `${cursor}=`, `${cursor}/`, "aaaa|" + "0".repeat(32), "../active.json"];
  for (const value of bad) refused(statusJson(state, "--after", value), 4, `cursor ${JSON.stringify(value.slice(0, 40))}`, "invalid_argument");
  refused(statusJson(state, "--after", cursor, "--since-generation", "7"), 4, "--after with --since-generation", "invalid_argument");
});

test("S9 JSON flag validation rejects bad syntax before any registry call", () => {
  const state = stateDir(registry(7, BASE));
  const badArgs = [
    ["--limit", "0"], ["--limit", "101"], ["--limit", "01"], ["--limit", "+5"], ["--limit", "-1"], ["--limit", "1.5"],
    ["--limit", "abc"], ["--limit", ""], ["--limit"], ["--limit=5"], ["--limit", "1", "--limit", "1"],
    ["--since-generation", "01"], ["--since-generation", "-1"], ["--since-generation", "9007199254740992"],
    ["--since-generation", "99999999999999999"], ["--since-generation", "x"], ["--since-generation", "1", "--since-generation", "1"],
    ["--live", "--live"], ["--bogus"], ["fx-alpha"], ["--json"], ["--after"], ["--live", "extra"],
  ];
  const fake = fakeBackend({ stdout: "not json at all\n" });
  for (const args of badArgs) {
    refused(tracker(state, ["status", "--json", ...args], fake.env), 4, args.join(" "), "invalid_argument");
    assert.ok(!fs.existsSync(fake.log), `${args.join(" ")}: registry was called before validation`);
  }
  refused(tracker(state, ["status", "--json", "--limit", "100", "--live"], fake.env), 3, "valid flags reach the backend", "malformed_output");
  assert.ok(fs.existsSync(fake.log), "positive control: valid flags do call the backend");
});

test("S10 malformed, oversized or failing backend output never produces partial stdout", () => {
  const state = stateDir(registry(7, BASE));
  const modes: Array<[string, string, string]> = [
    ["garbage", "not json at all\n", "malformed_output"],
    ["bad-header", "{\"generation\": \"7\", \"matching\": 0}\n", "malformed_output"],
    ["trailing", "{\"generation\": 7, \"matching\": 0}\nnot-json\n", "malformed_output"],
    ["huge", ("x".repeat(1023) + "\n").repeat(2048), "output_too_large"],
  ];
  for (const [mode, stdout, reason] of modes) {
    refused(tracker(state, ["status", "--json"], fakeBackend({ stdout }).env), 3, `backend ${mode}`, reason);
  }
  const legacyError = { stdout: "{\"result\": \"registry_corrupt\", \"detail\": \"fake\", \"completion_fact\": null}\n", rc: 9 };
  refused(tracker(state, ["status", "--json"], fakeBackend(legacyError).env), 9, "backend error JSON is not passed through", "registry_error");
});

test("S11 Unicode, control characters, non-UUID ids, missing and non-string timestamps", () => {
  const recs = [
    rec("x\uffff", "bmp", { dispatched_at: "2026-10-02T00:00:00Z" }),
    rec("x\u{1F986}", "astral", { dispatched_at: "2026-10-02T00:00:00Z" }),
    rec("legacy:7", "ctl\u0000\u001f\u007f\u2028\u2029\"\\", { track: "한글🦆", dispatched_at: "2026-10-02T00:00:00Z" }),
    rec("e-numeric-ts", "num", { dispatched_at: 12345 }),
    rec("d-missing-ts", "missing"),
    rec("é", "short", { dispatched_at: "" }),
  ];
  const state = stateDir(registry(11, recs));
  const want = ordered(recs).map(r => project(r).row);
  assert.deepEqual(want.slice(-2).map(r => r.dispatch_id), ["x\uffff", "x\u{1F986}"], "oracle orders by code point");
  assert.deepEqual(envelope(statusJson(state)).rows, want);
  assert.deepEqual(pageAll(state, "--limit", "1").ids, want.map(r => r.dispatch_id));
});

test("S12 identity bounds: 256 UTF-8 bytes is pageable, 257 bytes or a 129-byte timestamp fails explicitly", () => {
  const ok = [rec("a".repeat(256), "ascii256"), rec("☃".repeat(85), "snow255", { dispatched_at: "t".repeat(128) })];
  const state = stateDir(registry(5, ok));
  const { ids } = pageAll(state, "--limit", "1");
  assert.deepEqual(ids, ordered(ok).map(r => r.dispatch_id));
  for (const [name, bad] of [
    ["id 257 bytes", rec("a".repeat(257), "x")],
    ["id 258 bytes / 86 chars", rec("☃".repeat(86), "x")],
    ["timestamp 129 bytes", rec("short", "x", { dispatched_at: "t".repeat(129) })],
  ] as Array<[string, Rec]>) {
    const dir = stateDir(registry(5, [A, bad]));
    refused(statusJson(dir), 3, name, "identity_too_large");
    assert.equal(tracker(dir, ["status"]).code, 0, `${name}: legacy status unchanged`);
  }
});

test("S13 out-of-range registry generation is refused by the JSON branch only", () => {
  for (const generation of [-1, 9007199254740992, true, 1.5]) {
    const raw = JSON.stringify(registry(0, [A])).replace("\"generation\":0", `"generation":${generation === 9007199254740992 ? "9007199254740992" : String(generation)}`);
    const dir = stateDir(raw);
    const r = statusJson(dir);
    refused(r, 9, `generation ${generation}`, "registry_corrupt");
    if (generation === 1.5) continue; // legacy validate already rejects a float
    assert.equal(tracker(dir, ["status"]).code, 0, `generation ${generation}: legacy status unchanged`);
  }
});

test("S14 string length cap counts code points: 256 kept, 257 nulled and counted", () => {
  const recs = [rec("k256", "a", { track: "🦆".repeat(256), role: "r".repeat(256) }), rec("k257", "b", { track: "🦆".repeat(257) })];
  const page = envelope(statusJson(stateDir(registry(2, recs))));
  assert.deepEqual(page.rows, ordered(recs).map(r => project(r).row));
  assert.equal(page.oversize, 1);
});

test("S15 emitted bytes include JSON escaping: 2 MiB of escaped projection is exit 3 with empty stdout", () => {
  const ctl = "\u0001".repeat(256);
  const recs = Array.from({ length: 100 }, (_, i) => rec(`big-${String(i).padStart(3, "0")}`, ctl, {
    track: ctl, role: ctl, lifecycle: { state: ctl, at: ctl }, gate: { state: ctl }, transport: { result: ctl, at: ctl },
    expected_report_by: ctl, last_seen_at: ctl, last_observation: { kind: ctl, at: ctl }, dedup: { key: "k", ref_hash: ctl },
    dispatched_at: "2026-10-01T00:00:00Z",
  }));
  const state = stateDir(registry(4, recs));
  refused(statusJson(state, "--limit", "100"), 3, "escaped projection over the emit cap", "output_too_large");
  const small = envelope(statusJson(state, "--limit", "10"));
  assert.deepEqual(small.rows, ordered(recs).slice(0, 10).map(r => project(r).row), "256 control chars are kept verbatim");
});

test("S16 registry read bound: 32 MiB is read, one byte more is refused; legacy default load unchanged", () => {
  const body = JSON.stringify(registry(6, [A]));
  const atCap = stateDir(body + " ".repeat(READ_CAP - Buffer.byteLength(body)));
  assert.equal(envelope(statusJson(atCap)).rows.length, 1);
  fs.rmSync(atCap, { recursive: true });
  const over = stateDir(body + " ".repeat(READ_CAP + 1 - Buffer.byteLength(body)));
  const before = snapshot(over);
  refused(statusJson(over), 9, "registry over 32 MiB", "registry_too_large");
  refused(statusJson(over, "--since-generation", "6"), 9, "registry over 32 MiB with matching generation", "registry_too_large");
  assert.equal(tracker(over, ["status"]).code, 0, "legacy status keeps the unbounded default load");
  assert.deepEqual(snapshot(over), before);
  fs.rmSync(over, { recursive: true });
});

test("S17 corrupt and missing registries", () => {
  const corrupt = stateDir("{\"schema_version\": 2, \"generation\": 7, \"dispatches\": [{\"cwd\": \"" + CANARY + "\"");
  const bytes = fs.readFileSync(path.join(corrupt, "active.json"));
  refused(statusJson(corrupt), 9, "corrupt registry", "registry_corrupt");
  assert.deepEqual(fs.readFileSync(path.join(corrupt, "active.json")), bytes, "corrupt bytes preserved");
  const empty = stateDir(null);
  const page = envelope(statusJson(empty));
  assert.equal(page.generation, 0);
  assert.deepEqual(page.rows, []);
  assert.ok(!fs.existsSync(path.join(empty, "active.json")), "a read never creates the registry");
});

test("S18 help names status --json; unknown commands are unchanged", () => {
  const state = stateDir(registry(7, BASE));
  const help = tracker(state, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /status --json/);
  const unknown = tracker(state, ["bogus-1172"]);
  assert.equal(unknown.code, 4);
  assert.equal(unknown.stdout, "");
  assert.ok(unknown.stderr.startsWith("unknown: bogus-1172\n"));
});

test("S19 discovery: the orchestrate-turn skill names status --json and --since-generation", () => {
  const skill = fs.readFileSync(path.join(repoRoot, ".agents", "skills", "orchestrate-turn", "SKILL.md"), "utf8");
  assert.match(skill, /status --json/);
  assert.match(skill, /--since-generation/);
});

test("S20 actual caller: bin/dispatch-tracker.sh status --json equals the direct entrypoint", {
  skip: process.platform === "win32" ? "bash shim not measured on win32; direct entrypoint covered above" : false,
}, () => {
  const state = stateDir(registry(7, BASE));
  const direct = statusJson(state);
  const shim = run("bash", [path.join(binDir, "dispatch-tracker.sh"), "status", "--json"], state);
  assert.equal(envelope(shim).rows.length, 4);
  assert.equal(shim.stdout, direct.stdout);
});

// ── candidate-r1 controller resolutions (#1172 follow-up) ──────────────────
test("S21 a cursor is bound to its --live filter: a mismatched filter is exit 4 with no rows", () => {
  const state = stateDir(registry(7, BASE));
  const liveCursor = envelope(statusJson(state, "--live", "--limit", "1")).next_after!;
  const allCursor = envelope(statusJson(state, "--limit", "1")).next_after!;
  refused(statusJson(state, "--after", liveCursor), 4, "live cursor without --live", "invalid_argument");
  refused(statusJson(state, "--live", "--after", allCursor), 4, "unfiltered cursor with --live", "invalid_argument");
  const next = envelope(statusJson(state, "--live", "--after", liveCursor));
  assert.deepEqual(next.rows.map(r => r.dispatch_id), ordered(BASE.filter(live)).slice(1).map(r => r.dispatch_id));
});

test("S22 stale cursor on any generation change: decrease, increase with pruned row, --live pages", () => {
  const cases: Array<[string, string[], unknown]> = [
    ["generation decreased", [], registry(6, BASE)],
    ["generation increased, cursor row pruned", [], registry(9, BASE.filter(r => r !== ordered(BASE)[0]))],
    ["--live cursor, generation increased", ["--live"], registry(8, BASE)],
  ];
  for (const [name, flags, next] of cases) {
    const state = stateDir(registry(7, BASE));
    const cursor = envelope(statusJson(state, ...flags, "--limit", "1")).next_after!;
    fs.writeFileSync(path.join(state, "active.json"), JSON.stringify(next, null, 2) + "\n");
    refused(statusJson(state, ...flags, "--limit", "1", "--after", cursor), 3, name, "stale_cursor");
  }
});

test("S23 mutated invalid registries are registry_corrupt (9), also when the caller claims the same generation", () => {
  const dup = rec(A.dispatch_id as string, "dup");
  const mutants: Array<[string, unknown]> = [
    ["schema_version 1", { ...registry(7, BASE), schema_version: 1 }],
    ["root array", [A]],
    ["dispatches object", { schema_version: 2, generation: 7, dispatches: { a: A } }],
    ["empty dispatch_id", registry(7, [rec("", "x")])],
    ["duplicate dispatch_id", registry(7, [A, dup])],
    ["outcome reported", registry(7, [rec("o", "x", { outcome: { state: "done", reported_value: null } })])],
    ["gate not an object", registry(7, [rec("g", "x", { gate: "held" })])],
    ["generation string", registry("7", BASE)],
  ];
  for (const [name, doc] of mutants) {
    const state = stateDir(doc);
    const before = fs.readFileSync(path.join(state, "active.json"));
    refused(statusJson(state), 9, name, "registry_corrupt");
    refused(statusJson(state, "--since-generation", "7"), 9, `${name} with matching generation`, "registry_corrupt");
    assert.deepEqual(fs.readFileSync(path.join(state, "active.json")), before, `${name}: bytes preserved`);
  }
});

test("S24 the tracker parser accepts only a well-formed backend stream (mutants -> 3 malformed_output)", () => {
  const state = stateDir(registry(7, BASE));
  const control = envelope(tracker(state, ["status", "--json"], fakeBackend({ stdout: jsonlStream(), stderr: CANARY }).env));
  assert.deepEqual(control.rows, [jsonlRow()], "positive control: a valid stream is accepted and child stderr is dropped");
  const missing = jsonlRow();
  delete missing.track;
  const two = [jsonlRow({ dispatch_id: "a" }), jsonlRow({ dispatch_id: "b" })];
  const mutants: Array<[string, string, string[]]> = [
    ["empty stdout", "", []],
    ["no final LF", jsonlStream().slice(0, -1), []],
    ["CRLF", jsonlStream().replace(/\n/g, "\r\n"), []],
    ["raw non-ASCII", jsonlStream({}, [jsonlRow({ "assigned.sid": "é" })]), []],
    ["row lacks a key", jsonlStream({}, [missing]), []],
    ["row extra key", jsonlStream({}, [jsonlRow({ cwd: "x" })]), []],
    ["nested row value", jsonlStream({}, [jsonlRow({ track: { a: 1 } })]), []],
    ["array row", jsonlStream({ rows: 1 }, []) + "[]\n", []],
    ["row count above lines", jsonlStream({ rows: 2, matching: 2 }), []],
    ["trailing line", jsonlStream() + "{}\n", []],
    ["more without cursor", jsonlStream({ more: true }), []],
    ["cursor with path chars", jsonlStream({ more: true, next_after: "../a|b" }), []],
    ["unchanged without since", jsonlStream({ unchanged: true, rows: 0 }, []), []],
    ["header extra key", jsonlStream({ extra: 1 }), []],
    ["generation string", jsonlStream({ generation: "7" }), []],
    ["string 257 code points", jsonlStream({}, [jsonlRow({ track: "t".repeat(257) })]), []],
    ["empty dispatch_id", jsonlStream({}, [jsonlRow({ dispatch_id: "" })]), []],
    ["rows above --limit", jsonlStream({}, two), ["--limit", "1"]],
  ];
  for (const [name, stdout, flags] of mutants) {
    refused(tracker(state, ["status", "--json", ...flags], fakeBackend({ stdout }).env), 3, name, "malformed_output");
  }
});

test("S25 child stderr, paths and exit codes are never forwarded; only a fixed reason is named", () => {
  const state = stateDir(registry(7, BASE));
  const secret = `${CANARY} ${output}/secret/path`;
  const cases: Array<[string, FakeSpec, number, string]> = [
    ["rc 3 with secret stderr", { stderr: secret, rc: 3 }, 3, "registry_error"],
    ["rc 9 fixed reason", { stderr: "dispatch-registry: list --jsonl: registry_too_large\n", rc: 9 }, 9, "registry_too_large"],
    ["rc 9 path as reason", { stderr: `dispatch-registry: list --jsonl: ${output}\n`, rc: 9 }, 9, "registry_error"],
    ["rc 9 unknown reason", { stderr: "dispatch-registry: list --jsonl: not_a_reason\n", rc: 9 }, 9, "registry_error"],
    ["rc 1 traceback", { stdout: jsonlStream(), stderr: `Traceback: ${secret}\n`, rc: 1 }, 9, "registry_error"],
    ["rc 7", { rc: 7 }, 9, "registry_error"],
  ];
  if (process.platform !== "win32") cases.push(["killed by signal", { stdout: jsonlStream(), kill: true }, 9, "registry_error"]);
  for (const [name, spec, code, reason] of cases) {
    const r = tracker(state, ["status", "--json"], fakeBackend(spec).env);
    refused(r, code, name, reason);
    assert.ok(!r.stderr.includes(output), `${name}: no path in stderr`);
  }
  refused(tracker(state, ["status", "--json"], { DISPATCH_REGISTRY_PY: path.join(output, "absent-registry.py") }), 9,
    "unrunnable backend", "registry_error");
});

test("S26 actual registry list --jsonl: exact stream, fixed errors, legacy list parsing untouched", () => {
  const state = stateDir(registry(7, BASE));
  const ok = registryDirect(state, ["list", "--jsonl", "--limit", "2"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  assert.match(ok.stdout, /^[\x20-\x7e\n]+\n$/, "ASCII lines with a final LF");
  const [head, ...rows] = ok.stdout.slice(0, -1).split("\n").map(line => JSON.parse(line) as Rec);
  assert.deepEqual(head, { v: 1, generation: 7, unchanged: false, matching: 4, oversize: 0, more: true,
    next_after: head!.next_after, rows: 2 });
  assert.deepEqual(rows, ordered(BASE).slice(0, 2).map(r => project(r).row));
  assert.equal(registryDirect(state, ["list", "--jsonl", "--since-generation", "7"]).stdout,
    "{\"v\":1,\"generation\":7,\"unchanged\":true,\"matching\":4,\"oversize\":0,\"more\":false,\"next_after\":null,\"rows\":0}\n");
  const fixed = (r: Run, code: number, result: string, why: string) => {
    assert.equal(r.code, code, `${why}: exit`);
    assert.equal(r.stdout, "", `${why}: stdout`);
    assert.equal(r.stderr, `dispatch-registry: list --jsonl: ${result}${PY_EOL}`, `${why}: stderr`);
  };
  const corrupt = stateDir("{\"schema_version\": 2, \"generation\": 7, \"dispatches\": [{\"cwd\": \"" + CANARY + "\"");
  fixed(registryDirect(corrupt, ["list", "--jsonl"]), 9, "registry_corrupt", "corrupt");
  fixed(registryDirect(state, ["list", "--jsonl", "--limit", "0"]), 4, "invalid_argument", "limit 0");
  fixed(registryDirect(state, ["list", "--jsonl", "--fields", "cwd"]), 4, "invalid_argument", "legacy flag in new mode");
  fixed(registryDirect(state, ["list", "--jsonl", "--live", "--after", head!.next_after as string]), 4, "invalid_argument",
    "live mismatch");
  fs.writeFileSync(path.join(state, "active.json"), JSON.stringify(registry(8, BASE), null, 2) + "\n");
  fixed(registryDirect(state, ["list", "--jsonl", "--after", head!.next_after as string]), 3, "stale_cursor", "stale");
  const legacyLimit = registryDirect(state, ["list", "--limit", "5"]);
  assert.equal(legacyLimit.code, 4);
  assert.equal(legacyLimit.stderr, "");
  assert.deepEqual(JSON.parse(legacyLimit.stdout), { result: "invalid_argument", detail: "list: unknown field \u0027limit\u0027",
    completion_fact: null }, "without --jsonl, the new flags stay unknown to legacy list");
  const legacyValue = registryDirect(state, ["list", "--fields", "--jsonl"]);
  assert.equal(legacyValue.code, 0);
  assert.equal(legacyValue.stdout, `null${PY_EOL}`.repeat(4), "--jsonl as a --fields VALUE is not the new mode");
});

test("S27 a cursor over 2048 bytes (control-char identity within bounds) fails explicitly; one page still succeeds", () => {
  const recs = [rec("\u0001".repeat(256), "c1", { dispatched_at: "\u0001".repeat(128) }), rec("z", "c2", { dispatched_at: "2026" })];
  const state = stateDir(registry(7, recs));
  refused(statusJson(state, "--limit", "1"), 3, "cursor over 2048", "identity_too_large");
  assert.deepEqual(envelope(statusJson(state)).rows, ordered(recs).map(r => project(r).row));
});

// F1 (#1172 follow-up): the new path must bound its registry child. Desired contract: hard 5 s timeout,
// exit 9 with the fixed registry_error line, empty stdout, no backend stderr, no live child left.
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
test("S28 a backend that settles after 7 s is cut at the 5 s hard timeout and leaves no live process", t => {
  const state = stateDir(registry(7, BASE));
  const fake = fakeBackend({ stdout: jsonlStream(), stderr: `${CANARY} slow backend ${output}\n`, sleepSeconds: 7 });
  const pidFile = path.join(fake.dir, "pid");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SEAMS) delete env[key];
  Object.assign(env, { DISPATCH_STATE_DIR: state, AIGENTRY_SHIM_SCRIPT_DIR: binDir }, fake.env);
  const started = process.hrtime.bigint();
  let liveAfter = false;
  let r: ReturnType<typeof spawnSync> | undefined;
  try {
    // Outer bound 20 s, SIGKILL: a hung tracker can never stall the suite.
    r = spawnSync(process.execPath, [cli, "status", "--json"], { env, encoding: "utf8", shell: false, timeout: 20_000,
      killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
    liveAfter = Number.isSafeInteger(pid) && pid > 0 && alive(pid);
    if (liveAfter) process.kill(pid, "SIGKILL"); // owned child cleanup only
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(r, "tracker was spawned");
  t.diagnostic(`elapsed_ms=${Math.round(elapsedMs)} exit=${r.status} signal=${r.signal} stdout_bytes=${Buffer.byteLength(String(r.stdout))} live_after=${liveAfter}`);
  assert.ifError(r.error);
  assert.ok(fs.existsSync(pidFile), "the slow backend actually started");
  assert.ok(elapsedMs <= 6000, `status --json took ${Math.round(elapsedMs)} ms; the hard timeout must end it within 6 s`);
  assert.ok(elapsedMs >= 4500, `timeout fired early (${Math.round(elapsedMs)} ms); contract is 5 s`);
  assert.equal(liveAfter, false, "no live backend process after the tracker returns");
  refused({ code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) }, 9, "slow backend", "registry_error");
});

/** Runs status --json against a fake under the 20 s outer bound; reports elapsed and whether the fake survived. */
function boundedRun(fake: { env: Record<string, string>; dir: string }): { r: Run; elapsedMs: number; liveAfter: boolean } {
  const state = stateDir(registry(7, BASE));
  const pidFile = path.join(fake.dir, "pid");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SEAMS) delete env[key];
  Object.assign(env, { DISPATCH_STATE_DIR: state, AIGENTRY_SHIM_SCRIPT_DIR: binDir }, fake.env);
  const started = process.hrtime.bigint();
  let liveAfter = false;
  let res: ReturnType<typeof spawnSync> | undefined;
  try {
    res = spawnSync(process.execPath, [cli, "status", "--json"], { env, encoding: "utf8", shell: false, timeout: 20_000,
      killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
    liveAfter = Number.isSafeInteger(pid) && pid > 0 && alive(pid);
    if (liveAfter) process.kill(pid, "SIGKILL"); // owned child cleanup only
  }
  assert.ok(res, "tracker was spawned");
  assert.ifError(res.error);
  assert.ok(fs.existsSync(pidFile), "the fake backend actually started");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { r: { code: res.status, stdout: String(res.stdout), stderr: String(res.stderr) }, elapsedMs, liveAfter };
}

test("S29 output overflow from a backend that then stalls is cut at once: exit 3, no live child", t => {
  const fake = fakeBackend({ stdout: ("x".repeat(1023) + "\n").repeat(2048), stderr: `${CANARY}\n`, sleepSeconds: 7 });
  const { r, elapsedMs, liveAfter } = boundedRun(fake);
  t.diagnostic(`elapsed_ms=${Math.round(elapsedMs)} exit=${r.code} live_after=${liveAfter}`);
  assert.ok(elapsedMs <= 6000, `overflowing backend held the tracker ${Math.round(elapsedMs)} ms`);
  assert.equal(liveAfter, false, "the overflowing backend is killed, not left running");
  refused(r, 3, "overflow then stall", "output_too_large");
});

test("S30 a backend that ignores SIGTERM is still ended by the 5 s deadline (SIGKILL)", {
  skip: process.platform === "win32" ? "POSIX signal semantics; win32 termination unmeasured" : false,
}, t => {
  const fake = fakeBackend({ stdout: jsonlStream(), stderr: `${CANARY}\n`, sleepSeconds: 7, ignoreTerm: true });
  const { r, elapsedMs, liveAfter } = boundedRun(fake);
  t.diagnostic(`elapsed_ms=${Math.round(elapsedMs)} exit=${r.code} live_after=${liveAfter}`);
  assert.ok(elapsedMs <= 6000 && elapsedMs >= 4500, `deadline not enforced: ${Math.round(elapsedMs)} ms`);
  assert.equal(liveAfter, false, "no live backend after the tracker returns");
  refused(r, 9, "SIGTERM-ignoring backend", "registry_error");
});

test("S31 output overflow from a SIGTERM-ignoring backend is killed at once (maxBuffer uses SIGKILL)", {
  skip: process.platform === "win32" ? "POSIX signal semantics; win32 termination unmeasured" : false,
}, t => {
  const fake = fakeBackend({ stdout: ("x".repeat(1023) + "\n").repeat(2048), sleepSeconds: 7, ignoreTerm: true, survivePipe: true });
  const { r, elapsedMs, liveAfter } = boundedRun(fake);
  t.diagnostic(`elapsed_ms=${Math.round(elapsedMs)} exit=${r.code} live_after=${liveAfter}`);
  assert.ok(elapsedMs <= 6000, `overflowing SIGTERM-ignoring backend held the tracker ${Math.round(elapsedMs)} ms`);
  assert.equal(liveAfter, false, "no live backend after the tracker returns");
  refused(r, 3, "overflow from SIGTERM-ignoring backend", "output_too_large");
});
