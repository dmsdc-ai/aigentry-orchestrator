// ADR-MF #10 §3.4 — three-CLI BootCommand + self-test contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootAdapterError, CLI_KINDS, getBootAdapter, memoryBootFs, mockSpawner, type CliKind } from "../../src/session/boot-adapter/index.js";
import { Role, type SessionContext } from "../../src/session/types.js";
import type { ResolvedInstructions } from "../../src/session/resolve-instructions.js";
import { canonicalBytes, sha256Hex } from "../../src/session/persistence/canonical-bytes.js";
import { digestMismatchSpawner, leakingSpawner, readyForDigest } from "../fixtures/adr-mf/mock-spawner-presets.js";

const EFF = "COMMON\n\n---\n\nCODER\n\n---\n\nTASK\n";
const DIGEST = sha256Hex(canonicalBytes(EFF));
const ctx = (): SessionContext => ({ session_id: "S-B", role: Role.coder, cwd: "/work/myproj", task_id: "T-B", effective_prompt_digest: DIGEST, effective_prompt_path: "/snap/p.md", layers: [], spawn_chain: [], depth: 0, created_at: "2026-05-12T00:00:00+00:00" });
const resolved = (): ResolvedInstructions => ({ effective_prompt: EFF, effective_prompt_digest: DIGEST, layers: [], project_id: "myproj" });
const withStaging = async (label: string, fn: (s: string) => Promise<void>) => {
  const s = mkdtempSync(join(tmpdir(), `mf10-${label}-`));
  try { await fn(s); } finally { rmSync(s, { recursive: true, force: true }); }
};

test("B1 — every adapter yields a frozen BootCommand satisfying the contract", () => withStaging("B1", async (staging) => {
  for (const cli of CLI_KINDS) {
    const a = getBootAdapter(cli);
    const cmd = await a.buildBootCommand(ctx(), resolved(), { staging_dir: join(staging, cli), fs: memoryBootFs(), spawner: mockSpawner({ [cli]: readyForDigest() }) });
    assert.equal(cmd.argv[0], cli);
    assert.equal(cmd.expected_digest, DIGEST);
    assert.equal(cmd.code_scope_cwd, "/work/myproj");
    assert.ok(cmd.prompt_file.endsWith("effective_prompt.md"));
    assert.equal(Object.isFrozen(cmd), true);
    if (cli === "claude") assert.equal(cmd.cwd, "/work/myproj");
    else { assert.ok(cmd.cwd.startsWith(join(staging, cli))); assert.ok(cmd.cwd.endsWith("/control")); }
  }
}));

test("B2 — self-test happy path for every adapter", () => withStaging("B2", async (staging) => {
  for (const cli of CLI_KINDS) {
    const a = getBootAdapter(cli);
    const spawner = mockSpawner({ [cli]: readyForDigest() });
    const cmd = await a.buildBootCommand(ctx(), resolved(), { staging_dir: join(staging, cli), fs: memoryBootFs(), spawner });
    const r = await a.verifyBootSelfTest({ ctx: ctx(), resolved: resolved(), cmd, spawner });
    assert.equal(r.errors.length, 0);
    assert.equal(r.suppression_verified, true);
    assert.equal(r.adapter, cli);
  }
}));

test("B3 — wrong-digest stdout produces BOOT_DIGEST_MISMATCH", () => withStaging("B3", async (staging) => {
  const cli: CliKind = "claude";
  const a = getBootAdapter(cli);
  const cmd = await a.buildBootCommand(ctx(), resolved(), { staging_dir: join(staging, cli), fs: memoryBootFs(), spawner: mockSpawner({ [cli]: readyForDigest() }) });
  const r = await a.verifyBootSelfTest({ ctx: ctx(), resolved: resolved(), cmd, spawner: mockSpawner({ [cli]: digestMismatchSpawner("deadbeef".repeat(8)) }) });
  assert.equal(r.suppression_verified, false);
  assert.ok(r.errors.some((e) => e.code === "BOOT_DIGEST_MISMATCH"));
}));

test("B4 — leak marker in stdout produces BOOT_LEAK_DETECTED", () => withStaging("B4", async (staging) => {
  const cli: CliKind = "codex";
  const a = getBootAdapter(cli);
  const cmd = await a.buildBootCommand(ctx(), resolved(), { staging_dir: join(staging, cli), fs: memoryBootFs(), spawner: mockSpawner({ [cli]: readyForDigest() }) });
  const r = await a.verifyBootSelfTest({ ctx: ctx(), resolved: resolved(), cmd, spawner: mockSpawner({ [cli]: leakingSpawner("ORCH_DISPATCH_PROTOCOL_MARKER") }), leak_markers: ["ORCH_DISPATCH_PROTOCOL_MARKER"] });
  assert.equal(r.suppression_verified, false);
  assert.ok(r.errors.some((e) => e.code === "BOOT_LEAK_DETECTED"));
}));

test("B5 — unknown CLI rejected by registry with UNSUPPORTED_CLI", () => {
  assert.throws(() => getBootAdapter("opencode"), (e: unknown) => e instanceof BootAdapterError && e.code === "UNSUPPORTED_CLI");
});
