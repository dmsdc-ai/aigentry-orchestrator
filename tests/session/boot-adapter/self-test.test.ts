// ADR-MF #13 — fail-closed self-test framework contract.
// OQ2: mock-only; real-CLI READY ack deferred to upstream cooperation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getBootAdapter,
  memoryBootFs,
  mockSpawner,
  type SelfTestInput,
} from "../../../src/session/boot-adapter/index.js";
import { EXPECTED_DIGEST, makeCtx, makeResolved, readyScript } from "./_fixtures.js";

const STAGING = "/tmp/sess-S";

async function setup(cli: "claude" | "codex" | "gemini", overrideScript?: ReturnType<typeof readyScript>) {
  const adapter = getBootAdapter(cli);
  const fs = memoryBootFs();
  const buildSp = mockSpawner({ [cli]: readyScript() });
  const cmd = await adapter.buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs, spawner: buildSp,
  });
  const runSp = mockSpawner({ [cli]: overrideScript ?? readyScript() });
  const input: SelfTestInput = {
    ctx: makeCtx(), resolved: makeResolved(), cmd, spawner: runSp,
  };
  return { adapter, input, runSp };
}

test("7. version-drift: installed < min_version => CLI_VERSION_DRIFT", async () => {
  const { adapter, input } = await setup("claude", readyScript("0.0.1"));
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.suppression_verified, false);
  assert.equal(r.errors[0]?.code, "CLI_VERSION_DRIFT");
  assert.equal(r.version, "0.0.1");
});

test("8. READY <digest> happy path => suppression_verified true", async () => {
  const { adapter, input } = await setup("claude");
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.suppression_verified, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.adapter, "claude");
  assert.equal(r.version, "1.0.0");
});

test("9. BOOT_DIGEST_MISMATCH when stdout READY digest is wrong", async () => {
  const { adapter, input } = await setup("codex", {
    version: "1.0.0",
    features: ["--cd"],
    on_run: () => ({
      stdout: "READY abc123\n", stderr: "", exit_code: 0, duration_ms: 1,
    }),
  });
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.suppression_verified, false);
  assert.equal(r.errors[0]?.code, "BOOT_DIGEST_MISMATCH");
  assert.ok(r.errors[0]?.detail.includes(EXPECTED_DIGEST));
});

test("10. BOOT_LEAK_DETECTED when leak marker appears even if digest matches", async () => {
  const { adapter, input } = await setup("claude", {
    version: "1.0.0",
    features: ["--bare"],
    on_run: (cmd) => ({
      stdout: `READY ${cmd.expected_digest}\n<<CLAUDE_MD_LEAKED>>\n`,
      stderr: "", exit_code: 0, duration_ms: 1,
    }),
  });
  const inputWithMarker: SelfTestInput = {
    ...input, leak_markers: ["<<CLAUDE_MD_LEAKED>>"],
  };
  const r = await adapter.verifyBootSelfTest(inputWithMarker);
  assert.equal(r.suppression_verified, false);
  assert.ok(r.errors.some((e) => e.code === "BOOT_LEAK_DETECTED"));
});

test("11. BOOT_TIMEOUT when spawner.run rejects ETIMEDOUT", async () => {
  const { adapter, input } = await setup("claude", {
    version: "1.0.0",
    features: ["--bare"],
    on_run: () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
  });
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.errors[0]?.code, "BOOT_TIMEOUT");
});

test("11b. CLI_NOT_FOUND when spawner.run rejects ENOENT", async () => {
  const { adapter, input } = await setup("claude", {
    version: "1.0.0",
    features: ["--bare"],
    on_run: () => Object.assign(new Error("missing"), { code: "ENOENT" }),
  });
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.errors[0]?.code, "CLI_NOT_FOUND");
});

test("12. latency_ms is finite non-negative", async () => {
  const { adapter, input } = await setup("gemini");
  const r = await adapter.verifyBootSelfTest(input);
  assert.ok(Number.isFinite(r.latency_ms) && r.latency_ms >= 0);
});

test("12b. probeVersion failure surfaces CLI_NOT_FOUND (no run attempted)", async () => {
  const { adapter, input, runSp } = await setup("codex", {
    /* no version */ features: ["--cd"],
    on_run: () => ({ stdout: "", stderr: "", exit_code: 0, duration_ms: 1 }),
  });
  const r = await adapter.verifyBootSelfTest(input);
  assert.equal(r.errors[0]?.code, "CLI_NOT_FOUND");
  assert.equal(runSp.calls.length, 0);
});
