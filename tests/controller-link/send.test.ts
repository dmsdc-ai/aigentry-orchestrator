// Task 1291 — controller-link v1 send + classify (SPEC §6.1 steps 2–3), TEST-PLAN §2.3 C1–C7.
// Table-driven fixture outputs go into the pure classifier; the argv/env case uses a fake runner.
// The markers are the strings SPEC §6.1 and src/report/pump.ts submitOutcome() quote; the text around
// them in each fixture is illustrative only (the telepty source is not in this repository).
// The two runner cases spawn `node` itself (process.execPath), never telepty.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderEnvelope, type EnvelopeFields } from "../../src/controller-link/envelope.js";
import {
  DEFINITE_REFUSAL_CODES, RESOLVER_REFUSALS, SEND_FROM, SEND_TIMEOUT_MS, classifySend, defaultProcessRunner, sendEnvelope,
  type ProcessRunner, type RunnerResult, type SendClassification,
} from "../../src/controller-link/send.js";

const ID = "3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f";
const INJECT_ID = "0b7e9d2a-1c3f-4a5b-9d8e-7f6a5b4c3d2e";
const OTHER_ID = "1c8f0e3b-2d4a-4b6c-8e9f-8a7b6c5d4e3f";
const TARGET = "orchestrator@linux-box";
const ESC = "\u001b";

function requestText(body = "Please run the linux leg of task 1291.\nTwo lines."): string {
  const f: EnvelopeFields = { kind: "REQUEST", id: ID, seq: 1, ref: null, from: "mac", to: "linux",
    sent_at: "2026-11-22T10:00:00Z", sender_task: "1291", receiver_task: null, state: null, outcome: null,
    final: null, reason: null };
  const r = renderEnvelope(f, body);
  if (!r.ok) assert.fail(`fixture envelope refused: ${r.error.code}`);
  return r.envelope.text;
}

const cls = (rc: number | null, stdout: string, stderr = ""): SendClassification => classifySend({ rc, stdout, stderr });
const httpOk = (submitLine: string): string =>
  `✅ Context injected successfully into 'orchestrator' @ linux-box\ninject_id: ${INJECT_ID}\n${submitLine}\n`;

// ── C1–C3: HTTP arm, exactly one inject_id line, exit 0 ─────────────────────
test("C1 inject_id + '— consumed as a new turn.' → handed_over/consumed with the id", () => {
  assert.deepEqual(cls(0, httpOk("✅ Submitted — consumed as a new turn.")),
    { result: "handed_over", submit: "consumed", inject_id: INJECT_ID, detail: null });
});

test("C2 'QUEUED, NOT consumed' → handed_over/queued", () => {
  assert.deepEqual(cls(0, httpOk("⚠️ Submitted but QUEUED, NOT consumed (receiver busy)")),
    { result: "handed_over", submit: "queued", inject_id: INJECT_ID, detail: null });
});

test("C3 'consumption=unknown' → handed_over/unknown", () => {
  assert.deepEqual(cls(0, httpOk("Submitted; consumption=unknown")),
    { result: "handed_over", submit: "unknown", inject_id: INJECT_ID, detail: null });
  // CRLF output (Windows console) classifies the same.
  assert.equal(cls(0, httpOk("Submitted; consumption=unknown").replace(/\n/g, "\r\n")).result, "handed_over");
});

// ── C4: SSH arm, no inject id, ANSI colour ──────────────────────────────────
test("C4 SSH-arm success line with ANSI colour codes and no inject id → handed_over", () => {
  const line = `${ESC}[32m✅ Context injected successfully into '${ESC}[1morchestrator${ESC}[22m' @ linux-box${ESC}[0m\n`;
  assert.deepEqual(cls(0, line), { result: "handed_over", submit: "unknown", inject_id: null, detail: null });
  // Mutations of the line or of the exit code do not hand over.
  assert.equal(cls(0, "✅ Context injected into 'orchestrator' @ linux-box\n").result, "unknown");
  assert.equal(cls(0, "✅ Context injected successfully into '' @ linux-box\n").result, "unknown");
  assert.equal(cls(1, line).result, "unknown");
  // The success line counts on stdout only.
  assert.equal(cls(0, "", line).result, "unknown");
});

// ── C5: definite refusals ───────────────────────────────────────────────────
test("C5 each definite ❌ [CODE] with a non-zero exit → refused_definite naming the code", () => {
  assert.deepEqual([...DEFINITE_REFUSAL_CODES], ["TRACKING_PERSISTENCE_FAILED", "TRACKING_CAPACITY", "SESSION_NOT_FOUND",
    "PEER_INJECT_BLOCKED", "QUEUE_TIMEOUT", "INVALID_REQUEST", "POLL_ONLY"]);
  for (const code of DEFINITE_REFUSAL_CODES) {
    const want = { result: "refused_definite", submit: null, inject_id: null, detail: code };
    assert.deepEqual(cls(1, "", `❌ [${code}] no task bytes were delivered\n`), want, `${code} on stderr`);
    assert.deepEqual(cls(2, `❌ [${code}] refused\n`), want, `${code} on stdout`);
    assert.deepEqual(cls(1, "", `${ESC}[31m❌ [${code}]${ESC}[0m refused\n`), want, `${code} in colour`);
    // A longer code that merely starts with a listed one is not that code.
    assert.equal(cls(1, "", `❌ [${code}_X] refused\n`).result, "unknown", `${code}_X`);
  }
});

test("C5 both resolver refusals with a non-zero exit → refused_definite", () => {
  assert.equal(RESOLVER_REFUSALS.length, 2);
  const r1 = cls(1, "", "❌ Session 'orchestrator' was not found on any discovered host.\n");
  assert.deepEqual(r1, { result: "refused_definite", submit: null, inject_id: null, detail: "was not found on any discovered host" });
  const r2 = cls(1, "", "❌ No peer registered with machine id or address 'linux-box'.\n");
  assert.deepEqual(r2, { result: "refused_definite", submit: null, inject_id: null, detail: "No peer registered with machine id or address" });
});

// ── C6: unknown ─────────────────────────────────────────────────────────────
test("C6 non-zero exit WITH an inject_id line → unknown, even beside a definite code", () => {
  assert.deepEqual(cls(1, `inject_id: ${INJECT_ID}\n`, "❌ [TRACKING_CAPACITY] refused\n"),
    { result: "unknown", submit: null, inject_id: null, detail: "inject_id_with_nonzero_exit" });
  assert.equal(cls(1, `inject_id: ${INJECT_ID}\n`, "Submit failed\n").result, "unknown");
  assert.equal(cls(1, "", `inject_id: ${INJECT_ID}\n❌ [SESSION_NOT_FOUND]\n`).result, "unknown");
  assert.equal(cls(1, `inject_id: ${INJECT_ID}\n`, "was not found on any discovered host\n").result, "unknown");
});

test("C6 killed by the timeout (rc null) → unknown, whatever the text", () => {
  assert.equal(cls(null, "").result, "unknown");
  assert.equal(cls(null, httpOk("— consumed as a new turn.")).result, "unknown");
  assert.equal(cls(null, "", "❌ [TRACKING_PERSISTENCE_FAILED] refused\n").result, "unknown");
});

test("C6 any other text → unknown", () => {
  assert.equal(cls(0, "").result, "unknown");
  assert.equal(cls(0, "done\n").result, "unknown");
  assert.equal(cls(1, "", "❌ [SOMETHING_ELSE] refused\n").result, "unknown");
  assert.equal(cls(1, "", "Error: connect ECONNRESET\n").result, "unknown");
  assert.equal(cls(127, "", "").result, "unknown");
  // The refusal code must start a line (after indentation/colour); quoted mid-line it is not telepty's.
  assert.equal(cls(1, "", "  ❌ [SESSION_NOT_FOUND] refused\n").result, "refused_definite");
  assert.equal(cls(1, "", "Error: peer said ❌ [SESSION_NOT_FOUND]\n").result, "unknown");
  // Output that echoes an envelope (whose body may hold a refusal string) is never a definite refusal.
  assert.equal(cls(1, "", `failed to deliver:\n${requestText("❌ [TRACKING_CAPACITY] quoted by the body")}\n`).result, "unknown");
  // Exactly one inject_id line: two lines (same or different id) or a malformed id is not a handover.
  assert.equal(cls(0, `inject_id: ${INJECT_ID}\ninject_id: ${INJECT_ID}\n— consumed as a new turn.\n`).result, "unknown");
  assert.equal(cls(0, `inject_id: ${INJECT_ID}\ninject_id: ${OTHER_ID}\n`).result, "unknown");
  assert.equal(cls(0, "inject_id: not-a-uuid\n— consumed as a new turn.\n").result, "unknown");
  // The id must be on stdout.
  assert.equal(cls(0, "", `inject_id: ${INJECT_ID}\n`).result, "unknown");
});

// ── C7: argv, env, timeout ──────────────────────────────────────────────────
interface Call { bin: string; argv: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }

function fakeRunner(reply: RunnerResult): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: { run: async (bin, argv, opts) => { calls.push({ bin, argv: [...argv], env: opts.env, timeoutMs: opts.timeoutMs }); return reply; } },
  };
}

test("C7 argv is exactly inject --submit --no-submit-force --submit-retry 0 --from controller-link <target> <one element>", async () => {
  const text = requestText();
  const f = fakeRunner({ rc: 0, stdout: httpOk("— consumed as a new turn."), stderr: "", truncated: false });
  const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/u", TELEPTY_SESSION_ID: "orchestrator",
    TELEPTY_SESSION_TOKEN: "t", TELEPTY_SESSION_NONCE: "n", TELEPTY_SESSION_EXTRA: "x", TELEPTY_SUBMIT_FORCE_DEFAULT: "1" };
  const out = await sendEnvelope(TARGET, text, { runner: f.runner, bin: "telepty-test", baseEnv });
  assert.equal(f.calls.length, 1, "one attempt, no retry");
  const c = f.calls[0]!;
  assert.equal(c.bin, "telepty-test");
  assert.deepEqual(c.argv, ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", SEND_FROM, TARGET, text]);
  assert.equal(SEND_FROM, "controller-link");
  assert.equal(c.argv[c.argv.length - 1], text, "the whole envelope is the last single argv element, byte-exact");
  for (const banned of ["--ref", "--submit-force"]) assert.ok(!c.argv.includes(banned), banned);
  assert.deepEqual(Object.keys(c.env).filter((k) => k.startsWith("TELEPTY_SESSION_")), []);
  assert.equal(c.env.TELEPTY_SUBMIT_FORCE_DEFAULT, undefined);
  assert.equal(c.env.PATH, "/usr/bin");
  assert.equal(baseEnv.TELEPTY_SESSION_ID, "orchestrator", "the caller's env object is not mutated");
  assert.equal(c.timeoutMs, SEND_TIMEOUT_MS);
  assert.equal(SEND_TIMEOUT_MS, 120_000);
  assert.ok(out.attempted);
  if (out.attempted) assert.deepEqual(out.classification, { result: "handed_over", submit: "consumed", inject_id: INJECT_ID, detail: null });
});

test("C7 the same bytes are sent on a re-send; nothing is spawned for a non-canonical text or a bad target", async () => {
  const text = requestText();
  const f = fakeRunner({ rc: 1, stdout: "", stderr: "❌ [TRACKING_CAPACITY] refused\n", truncated: false });
  const a = await sendEnvelope(TARGET, text, { runner: f.runner });
  const b = await sendEnvelope(TARGET, text, { runner: f.runner });
  assert.ok(a.attempted && b.attempted);
  if (a.attempted) assert.equal(a.classification.result, "refused_definite");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.argv[8], f.calls[1]!.argv[8]);
  const g = fakeRunner({ rc: 0, stdout: "", stderr: "", truncated: false });
  for (const bad of [text + "\n", text.replace(/\n/g, "\r\n"), "hello", ""]) {
    const r = await sendEnvelope(TARGET, bad, { runner: g.runner });
    assert.equal(r.attempted, false);
    if (!r.attempted) assert.equal(r.code, "ENVELOPE_INVALID");
  }
  for (const t of ["orchestrator", "orchestrator@", "@linux-box", "a@b@c", "orch estrator@linux", "orchestrator@-x",
    "orchestrator@linux box", "-orch@linux", "orchestrator@linux\n"]) {
    const r = await sendEnvelope(t, text, { runner: g.runner });
    assert.equal(r.attempted, false, t);
    if (!r.attempted) assert.equal(r.code, "PEER_CONFIG_INVALID", t);
  }
  assert.equal(g.calls.length, 0, "nothing spawned");
});

test("C6 a truncated capture or a throwing runner is unknown", async () => {
  const text = requestText();
  const t = await sendEnvelope(TARGET, text, { runner: fakeRunner({ rc: 1, stdout: "", stderr: "❌ [POLL_ONLY]", truncated: true }).runner });
  assert.ok(t.attempted);
  if (t.attempted) assert.deepEqual(t.classification, { result: "unknown", submit: null, inject_id: null, detail: "output_truncated" });
  const thrower: ProcessRunner = { run: async () => { throw new Error("boom"); } };
  const x = await sendEnvelope(TARGET, text, { runner: thrower });
  assert.ok(x.attempted);
  if (x.attempted) assert.equal(x.classification.result, "unknown");
});

// ── the real runner, with node standing in for telepty ──────────────────────
test("runner: exit code, stdout, stderr and env reach the caller; no shell", async () => {
  const script = "process.stdout.write('out:' + process.argv[1] + ':' + (process.env.CL_TEST_VAR || '')); " +
    "process.stderr.write('err'); process.exit(3)";
  const arg = "a b; echo $HOME \"q\" ⟦x⟧";
  const r = await defaultProcessRunner.run(process.execPath, ["-e", script, arg],
    { env: { ...process.env, CL_TEST_VAR: "v1" }, timeoutMs: 30_000 });
  assert.deepEqual(r, { rc: 3, stdout: `out:${arg}:v1`, stderr: "err", truncated: false });
});

test("runner: a child that outlives the timeout is killed and reported rc null", async () => {
  const started = Date.now();
  const r = await defaultProcessRunner.run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"],
    { env: process.env, timeoutMs: 300 });
  assert.equal(r.rc, null);
  assert.ok(Date.now() - started < 20_000, "returned soon after the kill");
  assert.equal(classifySend(r).result, "unknown");
});

test("runner: a missing binary is rc null (unknown), never a definite refusal", async () => {
  const r = await defaultProcessRunner.run(resolve(import.meta.dirname, "no-such-telepty-binary"), ["inject"],
    { env: process.env, timeoutMs: 5_000 });
  assert.equal(r.rc, null);
  assert.equal(classifySend(r).result, "unknown");
});

test("send.ts has no store or filesystem access", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../../src/controller-link/send.ts"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["../dispatch/inject-id.js", "../report/decide.js", "../report/pump.js",
    "./envelope.js", "cross-spawn", "node:child_process"]);
});
