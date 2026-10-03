// T145 (#1092) — an unknown-state registry row must not block the orchestrator's
// own retry without an override, and the override must not be able to double a
// delivery whose state is known.
//   (a) without `--retry-unknown` the #727/#736 hold is byte-identical: exit 7,
//       the same message, no inject, the row stays delivery_state_unknown.
//   (b) `--retry-unknown "<reason>"` on that row: ONE registry transaction marks the
//       old row `superseded` (observation superseded_by_retry → new dispatch_id) and
//       creates the new row with observation retry_of_unknown {retry_of, reason};
//       the retry then runs the normal inject + ledger + dispatch_ack leg.
//   (c) the flag on a row whose transport was observed is refused (exit 4) naming
//       the row's lifecycle+transport, and writes nothing — at the CLI's check-dedup
//       fast path and at the registry's begin-delivery backstop alike.
//   (d) the flag with no prior attempt, or with an empty reason, is refused before
//       any side effect.
//   (e) --spawn-and-dispatch hits the same hold; with the flag the retry goes to
//       the existing worker (route=existing) and never opens a second workspace.
// Rows are seeded through the registry itself (the only writer), never by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

const REGISTRY = join(REPO, "bin/dispatch-registry.py");
const SID = "router-fixture";
const REASON = "reviewed: peer-lane guard refused the worker's inject, no bytes landed";
const HOLD_MSG = `dispatch.sh: DISPATCH_RETRY_HELD for ${SID} — a prior attempt's delivery is unknown; review before retrying`;

type Row = { dispatch_id: string; lifecycle: { state: string }; transport: { result: string };
  observations: Array<Record<string, unknown>> };
type F = ReturnType<typeof fixture>;

function registry(f: F, args: string[]) {
  return spawnSync("python3", [REGISTRY, ...args], { env: f.env, encoding: "utf8" });
}
function seed(f: F, transport: "unknown" | "write_observed"): string {
  f.prepareTarget(); // Release confinement requires a recipient receipt for retry preparation.
  const hash = createHash("sha256").update(readFileSync(f.ref)).digest("hex");
  const begin = registry(f, ["begin-delivery", "--sid", SID, "--ref-hash", hash, "--ref-path", f.ref]);
  assert.equal(begin.status, 0, begin.stdout + begin.stderr);
  const set = registry(f, ["set-transport-result", "--sid", SID, "--result", transport]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  return JSON.parse(begin.stdout).dispatch_id as string;
}
function doc(f: F) {
  return JSON.parse(readFileSync(join(f.root, "state/active.json"), "utf8")) as { generation: number; dispatches: Row[] };
}
function kinds(row: Row) { return row.observations.map((o) => o.kind); }
function injected(f: F) { return existsSync(f.env.PARENT_MODEL_LOG!); }
function telemetry(f: F, subtype: string) {
  if (!existsSync(f.env.TELEMETRY_LOG!)) return [];
  return readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
    .filter((e) => e[e.indexOf("--subtype") + 1] === subtype)
    .map((e) => JSON.parse(e[e.indexOf("--payload-json") + 1]!) as Record<string, unknown>);
}

test("T145(a): without the flag the hold is unchanged — exit 7, same message, no inject, row stays unknown", () => {
  const f = fixture();
  try {
    const prior = seed(f, "unknown");
    const r = f.dispatch(["--target", SID]);
    assert.equal(r.status, 7, r.stderr);
    assert.ok(r.stderr.split("\n").includes(HOLD_MSG), r.stderr);
    assert.equal(injected(f), false);
    const rows = doc(f).dispatches;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.dispatch_id, prior);
    assert.equal(rows[0]!.lifecycle.state, "delivery_state_unknown");
    assert.ok(kinds(rows[0]!).includes("dedup_retry_held"));
  } finally { f.cleanup(); }
});

test("T145(b): --retry-unknown supersedes the unknown row, records retry_of + reason on the new one, and runs inject + ledger + dispatch_ack", () => {
  const f = fixture();
  try {
    const prior = seed(f, "unknown");
    const r = f.dispatch(["--target", SID, "--retry-unknown", REASON]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`OK dispatched to ${SID}`));
    assert.equal(injected(f), true);
    const rows = doc(f).dispatches;
    assert.equal(rows.length, 2);
    const [old, fresh] = rows as [Row, Row];
    assert.equal(old.dispatch_id, prior);
    assert.equal(old.lifecycle.state, "superseded");
    assert.equal(old.transport.result, "unknown", "nothing measured the old delivery; supersession must not claim otherwise");
    const sup = old.observations.find((o) => o.kind === "superseded_by_retry")!;
    assert.deepEqual({ superseded_by: sup.superseded_by, reason: sup.reason, terminal: sup.terminal },
      { superseded_by: fresh.dispatch_id, reason: REASON, terminal: false });
    assert.notEqual(fresh.dispatch_id, prior);
    assert.equal(fresh.transport.result, "write_observed");
    const retry = fresh.observations.find((o) => o.kind === "retry_of_unknown")!;
    assert.deepEqual({ retry_of: retry.retry_of, reason: retry.reason, terminal: retry.terminal },
      { retry_of: prior, reason: REASON, terminal: false });
    const task = JSON.parse(readFileSync(f.queue, "utf8")).tasks[0];
    assert.equal(task.status, "delegated");
    assert.match(task.note, new RegExp(`dispatched .* sid=${SID} ref=ref.md`));
    assert.deepEqual(telemetry(f, "dispatch_ack").map((p) => p.target_sid), [SID]);
    // The registry now answers "delivered" for this sid+ref: a third identical
    // dispatch is deduplicated (exit 8), not held on the superseded row.
    const again = f.dispatch(["--target", SID]);
    assert.equal(again.status, 8, again.stderr);
  } finally { f.cleanup(); }
});

test("T145(c): the flag on a row whose transport was observed is refused naming the state, at the CLI and at the registry, without a write", () => {
  const f = fixture();
  try {
    const prior = seed(f, "write_observed");
    const before = doc(f).generation;
    const r = f.dispatch(["--target", SID, "--retry-unknown", REASON]);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, new RegExp(`dispatch\\.sh: DISPATCH_RETRY_REFUSED for ${SID} — --retry-unknown applies only to a delivery_state_unknown row; prior ${prior} is lifecycle=delivery_attempt_started transport=write_observed`));
    assert.equal(injected(f), false);
    assert.equal(doc(f).generation, before, "a refused flag must not write");
    // The atomic backstop inside begin-delivery gives the same answer.
    const hash = createHash("sha256").update(readFileSync(f.ref)).digest("hex");
    const b = registry(f, ["begin-delivery", "--sid", SID, "--ref-hash", hash, "--retry-unknown", REASON]);
    assert.equal(b.status, 4, b.stdout + b.stderr);
    const out = JSON.parse(b.stdout);
    assert.equal(out.result, "DISPATCH_RETRY_REFUSED");
    assert.equal(out.dispatch_id, prior);
    assert.equal(out.prior_lifecycle, "delivery_attempt_started");
    assert.equal(out.prior_transport, "write_observed");
    assert.equal(out.new_delivery, false);
    assert.equal(doc(f).generation, before);
    assert.equal(doc(f).dispatches.length, 1);
  } finally { f.cleanup(); }
});

test("T145(d): the flag with no prior attempt, or with an empty reason, is refused before any side effect", () => {
  const f = fixture();
  try {
    f.prepareTarget(); // Release confinement requires a recipient receipt before retry preparation.
    const none = f.dispatch(["--target", SID, "--retry-unknown", REASON]);
    assert.equal(none.status, 4, none.stderr);
    assert.match(none.stderr, new RegExp(`DISPATCH_RETRY_REFUSED for ${SID} — --retry-unknown applies only to a delivery_state_unknown row; no prior attempt for this sid\\+ref`));
    const empty = f.dispatch(["--target", SID, "--retry-unknown", "  "]);
    assert.equal(empty.status, 4, empty.stderr);
    assert.match(empty.stderr, /--retry-unknown needs a non-empty reason/);
    assert.equal(injected(f), false);
    assert.equal(doc(f).dispatches.length, 0);
    assert.equal(telemetry(f, "dispatch_start").length, 0, "refusal happens before the dispatch starts");
  } finally { f.cleanup(); }
});

test("T145(e): --spawn-and-dispatch hits the same hold; with the flag it retries the existing worker and never opens a second workspace", () => {
  const f = fixture();
  try {
    const prior = seed(f, "unknown");
    const held = f.dispatch(f.spawnArgs);
    assert.equal(held.status, 7, held.stderr);
    assert.ok(held.stderr.split("\n").includes(HOLD_MSG), held.stderr);
    assert.equal(existsSync(f.env.OPEN_LOG!), false, "a held spawn must not open a workspace");
    const r = f.dispatch([...f.spawnArgs, "--retry-unknown", REASON]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(f.env.OPEN_LOG!), false, "the prior row proves the worker exists; no second workspace");
    assert.equal(f.calls(), 0, "no routing for an existing worker");
    assert.equal(injected(f), true);
    const rows = doc(f).dispatches;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.lifecycle.state, "superseded");
    assert.equal(rows[1]!.observations.find((o) => o.kind === "retry_of_unknown")!.retry_of, prior);
    const start = telemetry(f, "dispatch_start").at(-1)!;
    assert.equal(start.mode, "spawn-and-dispatch");
    assert.equal((start.route as { decided_by: string }).decided_by, "existing");
    assert.deepEqual(telemetry(f, "dispatch_ack").map((p) => p.target_sid), [SID]);
  } finally { f.cleanup(); }
});

test("T145(f): atomic retry refusal with no prior row or blank reason never writes", () => {
  const f = fixture();
  try {
    const hash = createHash("sha256").update(readFileSync(f.ref)).digest("hex");
    const args = ["begin-delivery", "--sid", SID, "--ref-hash", hash, "--retry-unknown"];
    const before = doc(f).generation;
    const absent = registry(f, [...args, REASON]);
    assert.equal(absent.status, 4, absent.stdout + absent.stderr);
    assert.equal(JSON.parse(absent.stdout).result, "DISPATCH_RETRY_REFUSED");
    assert.equal(doc(f).generation, before);
    assert.equal(doc(f).dispatches.length, 0);
    seed(f, "unknown");
    const seeded = doc(f).generation;
    const blank = registry(f, [...args, "  "]);
    assert.equal(blank.status, 4, blank.stdout + blank.stderr);
    assert.equal(JSON.parse(blank.stdout).result, "DISPATCH_RETRY_REFUSED");
    assert.equal(doc(f).generation, seeded);
    assert.equal(doc(f).dispatches.length, 1);
    assert.equal(doc(f).dispatches[0]!.lifecycle.state, "delivery_state_unknown");
  } finally { f.cleanup(); }
});

test("T145(g): delivery becomes known after preflight; atomic recheck refuses without another inject", () => {
  const f = fixture();
  try {
    const prior = seed(f, "unknown");
    const before = doc(f).generation;
    const probe = f.script("retry-race-probe", `
const r = require("node:child_process").spawnSync("python3",
  [${JSON.stringify(REGISTRY)}, "set-transport-result", "--sid", ${JSON.stringify(SID)}, "--result", "write_observed"],
  { env: process.env, encoding: "utf8" });
if (r.status !== 0) { process.stderr.write(r.stderr || r.stdout); process.exit(99); }
console.log('{"ready":true}');
`);
    const r = f.dispatch(["--target", SID, "--retry-unknown", REASON], { SESSION_PROBE_PY: probe });
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /DISPATCH_RETRY_REFUSED/);
    assert.match(r.stderr, /transport=write_observed/);
    assert.equal(injected(f), false);
    const state = doc(f);
    assert.equal(state.generation, before + 1, "only the race's transport observation writes");
    assert.equal(state.dispatches.length, 1);
    assert.equal(state.dispatches[0]!.dispatch_id, prior);
    assert.equal(kinds(state.dispatches[0]!).includes("superseded_by_retry"), false);
    assert.equal(telemetry(f, "dispatch_ack").length, 0);
    assert.equal(JSON.parse(readFileSync(f.queue, "utf8")).tasks[0].status, "pending");
  } finally { f.cleanup(); }
});
