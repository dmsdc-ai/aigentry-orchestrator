// Task 1201 — SPEC §4.1 / §9.2 "Size": a 50 MiB synthetic transcript with 10k requests yields
// ≤ 9,216 bytes, ≤ 200 lines, every line ≤ 300 chars, in < 2.5 s (the boot step's whole budget,
// SPEC §6.1). Run for claude and for codex — Phase 0 measured a live 547 MB codex rollout
// (P0-2), so the codex adapter must tail, never read whole.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { type Box, at, boundViolations, dropBox, makeBox, plantClaude, plantCodex, runCli } from "./harness.js";

const MIB = 1024 * 1024;
const N = 10_000;

function bigClaude(): string {
  const pad = "w".repeat(5_300);
  const out: string[] = [];
  for (let i = 0; i < N; i++) {
    const ts = new Date(Date.UTC(2026, 9, 8, 0, 0, 0) + i * 1000).toISOString();
    out.push(JSON.stringify({ type: "user", cwd: "__WORKSPACE__", sessionId: "__SESSION__", isSidechain: false, timestamp: ts, uuid: `u${i}`, origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: `CH-SIZE-${i} ${pad}` } }));
  }
  return out.join("\n") + "\n";
}

function bigCodex(): string {
  const pad = "w".repeat(5_300);
  const out: string[] = [JSON.stringify({ timestamp: "2026-10-08T00:00:00.000Z", ordinal: 0, type: "session_meta", payload: { id: "__SESSION__", timestamp: "2026-10-08T00:00:00.000Z", cwd: "__WORKSPACE__", originator: "codex_cli_rs", cli_version: "0.157.1", source: "cli" } })];
  for (let i = 0; i < N; i++) {
    const ts = new Date(Date.UTC(2026, 9, 8, 0, 0, 1) + i * 1000).toISOString();
    out.push(JSON.stringify({ timestamp: ts, ordinal: i + 1, type: "turn_context", payload: { turn_id: `t${i}`, cwd: "__WORKSPACE__" } }));
    out.push(JSON.stringify({ timestamp: ts, ordinal: i + 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `CH-SIZE-${i} ${pad}` }] } }));
  }
  return out.join("\n") + "\n";
}

function check(b: Box, file: string): void {
  assert.ok(fs.statSync(file).size >= 50 * MIB, `fixture is ${fs.statSync(file).size} bytes, want ≥ 50 MiB`);
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(boundViolations(r.stdout), []);
  assert.ok(r.stdout.includes(`CH-SIZE-${N - 1}`), "the newest request is carried");
  // Whole process, node start-up included: stricter than the in-boot step it stands for.
  assert.ok(r.ms < 2_500, `took ${Math.round(r.ms)} ms, budget 2,500 ms`);
}

test("claude: 50 MiB, 10k requests → bounded output in < 2.5 s", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(10), text: bigClaude() });
  check(b, p.file);
});

test("codex: 50 MiB, 10k requests → bounded output in < 2.5 s", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantCodex(b, { last: at(10), text: bigCodex() });
  check(b, p.file);
});
