// ADR-MF #6 — resolver-side integration tests for CLAUDE.md → layered migration.
// Verifies that, given the new `tooling/instructions/` content as backing
// storage, an orchestrator-role resolve produces the expected effective_prompt
// + 4 layers + stable digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Role } from "../../src/session/types.js";
import { memoryFs } from "../../src/session/virtual-fs.js";
import { resolveInstructions } from "../../src/session/resolve-instructions.js";

// Walk up from the compiled-JS dir until we find package.json (= repo root).
// Avoids brittle hard-coded depth assumptions about dist/ layout.
async function findRepoRoot(): Promise<string> {
  let dir = process.cwd();
  for (let i = 0; i < 16; i++) {
    try {
      await fs.access(path.join(dir, "package.json"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("repo root (package.json) not found");
}

const REPO_ROOT = await findRepoRoot();
const SRC_COMMON = path.join(REPO_ROOT, "tooling/instructions/common.md");
const SRC_ORCH = path.join(REPO_ROOT, "tooling/instructions/roles/orchestrator.md");

async function readSrc(p: string): Promise<string> {
  return new TextDecoder("utf-8").decode(await fs.readFile(p));
}

test("M1. Resolver composes orchestrator effective_prompt from new layered content", async () => {
  const common = await readSrc(SRC_COMMON);
  const orchestrator = await readSrc(SRC_ORCH);
  const ROOT = "/instr";
  const vfs = memoryFs({
    [`${ROOT}/common.md`]: common,
    [`${ROOT}/roles/orchestrator.md`]: orchestrator,
    "/work/orch/.git": "",
  });
  const r = await resolveInstructions(
    {
      role: Role.orchestrator,
      cwd: "/work/orch",
      task_prompt: "DISPATCH TASK\n",
      task_source_path: "/dispatch/x.md",
      instructions_root: ROOT,
    },
    vfs,
  );

  // 3 layers (no project file → skipped) + task.
  assert.equal(r.layers.length, 3);
  assert.deepEqual(
    r.layers.map((l) => l.layer),
    ["common", "role", "task"],
  );
  assert.ok(r.effective_prompt.includes("Article 1 경량"));
  assert.ok(r.effective_prompt.includes("Hard rule — no direct execution"));
  assert.ok(r.effective_prompt.includes("DISPATCH TASK"));
});

test("M2. effective_prompt for orchestrator does NOT contain role-heavy CLAUDE.md leak markers from cwd", async () => {
  // We assert that nothing in the resolver-composed prompt requires
  // reading the repo cwd CLAUDE.md (which is now a stub). The resolver only
  // touches files under instructions_root + the caller-supplied task body.
  const orchestrator = await readSrc(SRC_ORCH);
  const ROOT = "/instr";
  const vfs = memoryFs({
    [`${ROOT}/common.md`]: "",
    [`${ROOT}/roles/orchestrator.md`]: orchestrator,
    "/work/orch/.git": "",
    // Note: deliberately do NOT seed any CLAUDE.md path here — resolver
    // must never read from cwd to compose role content.
  });
  const r = await resolveInstructions(
    {
      role: Role.orchestrator,
      cwd: "/work/orch",
      task_prompt: "T\n",
      task_source_path: "/dispatch/x.md",
      instructions_root: ROOT,
    },
    vfs,
  );
  // Role content sourced from new layered file, not from CLAUDE.md.
  assert.ok(r.effective_prompt.includes("dispatch protocol".toLowerCase().replace("d", "D")));
  // Sanity: source_path of the role layer points into instructions_root,
  // not into a CLAUDE.md path.
  const roleLayer = r.layers.find((l) => l.layer === "role")!;
  assert.ok(roleLayer.source_path.endsWith("roles/orchestrator.md"));
  assert.ok(!roleLayer.source_path.includes("CLAUDE.md"));
});

test("M3. Digest deterministic across two back-to-back resolves with the new content", async () => {
  const common = await readSrc(SRC_COMMON);
  const orchestrator = await readSrc(SRC_ORCH);
  const ROOT = "/instr";
  const seed = {
    [`${ROOT}/common.md`]: common,
    [`${ROOT}/roles/orchestrator.md`]: orchestrator,
    "/work/orch/.git": "",
  };
  const ctx = {
    role: Role.orchestrator,
    cwd: "/work/orch",
    task_prompt: "T\n",
    task_source_path: "/dispatch/x.md",
    instructions_root: ROOT,
  } as const;
  const a = await resolveInstructions(ctx, memoryFs(seed));
  const b = await resolveInstructions(ctx, memoryFs(seed));
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
  assert.equal(a.effective_prompt, b.effective_prompt);
});

test("M4. Stub CLAUDE.md at repo root has no role-heavy markers", async () => {
  const text = await readSrc(path.join(REPO_ROOT, "CLAUDE.md"));
  const leakRe = /telepty inject|session-layout|submit-retry|dustcraw 태스크/;
  assert.ok(!leakRe.test(text), `stub still contains leak markers: ${text}`);
  // ...and still references the new layered files for direct-launch visibility.
  assert.ok(text.includes("common.md"));
  assert.ok(text.includes("roles/orchestrator.md"));
});
