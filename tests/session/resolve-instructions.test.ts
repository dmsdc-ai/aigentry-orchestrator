// ADR-MF #4 — resolveInstructions() contract tests (SPEC §7 — 16 scenarios).
// node:test + assert/strict; all FS via memoryFs() (hermetic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Role, ROLES } from "../../src/session/types.js";
import { memoryFs } from "../../src/session/virtual-fs.js";
import {
  resolveInstructions,
  type ResolveContext,
} from "../../src/session/resolve-instructions.js";
import {
  canonicalBytes,
  sha256Hex,
} from "../../src/session/persistence/canonical-bytes.js";

const ROOT = "/instr";

function baseCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  const ctx: ResolveContext = {
    role: Role.coder,
    cwd: "/work/myproj",
    task_prompt: "TASK BODY\n",
    task_source_path: "/dispatch/t.md",
    instructions_root: ROOT,
  };
  return Object.assign(ctx, over);
}

function fullFs(extra: Record<string, string | Uint8Array> = {}) {
  return memoryFs({
    [`${ROOT}/common.md`]: "COMMON\n",
    [`${ROOT}/projects/myproj.md`]: "PROJ\n",
    [`${ROOT}/roles/coder.md`]: "CODER ROLE\n",
    "/work/myproj/.git": "",
    ...extra,
  });
}

test("1. All 4 layers compose in deterministic order", async () => {
  const r = await resolveInstructions(baseCtx(), fullFs());
  assert.equal(r.layers.length, 4);
  assert.deepEqual(
    r.layers.map((l) => l.layer),
    ["common", "project", "role", "task"],
  );
  assert.equal(
    r.effective_prompt,
    "COMMON\n\n---\n\nPROJ\n\n---\n\nCODER ROLE\n\n---\n\nTASK BODY\n",
  );
});

test("2. Layer source identity recorded for each layer", async () => {
  const r = await resolveInstructions(baseCtx(), fullFs());
  for (const l of r.layers) {
    assert.match(l.content_sha256, /^[0-9a-f]{64}$/);
    assert.ok(l.source_path.length > 0);
    assert.ok(!Number.isNaN(Date.parse(l.read_at)));
  }
});

test("3. project_id=none -> 3 layers, no project entry", async () => {
  const fs = memoryFs({
    [`${ROOT}/common.md`]: "C\n",
    [`${ROOT}/roles/coder.md`]: "R\n",
  });
  const r = await resolveInstructions(baseCtx({ cwd: "/nowhere" }), fs);
  assert.equal(r.project_id, "none");
  assert.equal(r.layers.length, 3);
  assert.ok(!r.layers.some((l) => l.layer === "project"));
});

test("4. Missing role file -> graceful skip (no throw)", async () => {
  const fs = memoryFs({
    [`${ROOT}/common.md`]: "C\n",
    "/work/myproj/.git": "",
  });
  const r = await resolveInstructions(baseCtx(), fs);
  assert.ok(!r.layers.some((l) => l.layer === "role"));
  // common + task present; project file not registered → also missing.
  assert.equal(r.layers.length, 2);
});

test("5. Determinism: same inputs -> identical digest", async () => {
  const a = await resolveInstructions(baseCtx(), fullFs());
  const b = await resolveInstructions(baseCtx(), fullFs());
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
  assert.equal(a.effective_prompt, b.effective_prompt);
});

test("6. CRLF -> LF canonicalization preserves digest", async () => {
  const lf = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "L1\nL2\n" }),
  );
  const crlf = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "L1\r\nL2\r\n" }),
  );
  assert.equal(lf.effective_prompt_digest, crlf.effective_prompt_digest);
});

test("7. NFD -> NFC canonicalization preserves digest", async () => {
  // Hangul "한": decomposed (U+1112 U+1161 U+11AB) vs precomposed (U+D55C).
  const nfd = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "\u1112\u1161\u11AB\n" }),
  );
  const nfc = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "\uD55C\n" }),
  );
  assert.equal(nfd.effective_prompt_digest, nfc.effective_prompt_digest);
});

test("8. BOM strip preserves digest", async () => {
  const bom = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "\uFEFFHELLO\n" }),
  );
  const plain = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "HELLO\n" }),
  );
  assert.equal(bom.effective_prompt_digest, plain.effective_prompt_digest);
});

test("9. Trailing-whitespace trim per line", async () => {
  const dirty = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "foo   \nbar\t\n" }),
  );
  const clean = await resolveInstructions(
    baseCtx(),
    fullFs({ [`${ROOT}/common.md`]: "foo\nbar\n" }),
  );
  assert.equal(dirty.effective_prompt_digest, clean.effective_prompt_digest);
});

test("10. All 9 roles resolve to their role file", async () => {
  for (const role of ROLES) {
    const fs = memoryFs({
      [`${ROOT}/common.md`]: "C\n",
      [`${ROOT}/roles/${role}.md`]: `ROLE=${role}\n`,
      "/work/myproj/.git": "",
    });
    const r = await resolveInstructions(baseCtx({ role }), fs);
    const roleLayer = r.layers.find((l) => l.layer === "role");
    assert.ok(roleLayer, `role layer missing for ${role}`);
    assert.equal(roleLayer.source_path, `${ROOT}/roles/${role}.md`);
  }
});

test("11. Empty common.md -> deterministic digest", async () => {
  const mkFs = () =>
    memoryFs({
      [`${ROOT}/common.md`]: "",
      [`${ROOT}/roles/coder.md`]: "R\n",
      "/work/myproj/.git": "",
    });
  const r1 = await resolveInstructions(baseCtx(), mkFs());
  const r2 = await resolveInstructions(baseCtx(), mkFs());
  assert.equal(r1.effective_prompt_digest, r2.effective_prompt_digest);
  // common layer entry is present even when empty.
  assert.ok(r1.layers.some((l) => l.layer === "common"));
});

test("12. Layer order forced regardless of insertion order", async () => {
  // memoryFs insertion order is irrelevant; output must still be common→project→role→task.
  const fs = memoryFs({
    "/work/myproj/.git": "",
    [`${ROOT}/roles/coder.md`]: "R\n",
    [`${ROOT}/projects/myproj.md`]: "P\n",
    [`${ROOT}/common.md`]: "C\n",
  });
  const r = await resolveInstructions(baseCtx(), fs);
  assert.deepEqual(
    r.layers.map((l) => l.layer),
    ["common", "project", "role", "task"],
  );
});

test("13. Delimiter contract: split count equals layer count", async () => {
  const r = await resolveInstructions(baseCtx(), fullFs());
  assert.equal(r.effective_prompt.split("\n\n---\n\n").length, r.layers.length);
});

test("14. Digest equals sha256(canonicalBytes(effective_prompt))", async () => {
  const r = await resolveInstructions(baseCtx(), fullFs());
  assert.equal(
    r.effective_prompt_digest,
    sha256Hex(canonicalBytes(r.effective_prompt)),
  );
});

test("15. project_id from .aigentry/project.json is authoritative", async () => {
  const fs = memoryFs({
    [`${ROOT}/common.md`]: "C\n",
    [`${ROOT}/projects/explicit-pid.md`]: "EXPLICIT PROJ\n",
    [`${ROOT}/roles/coder.md`]: "R\n",
    "/work/myproj/.aigentry/project.json": '{"project_id":"explicit-pid"}',
  });
  const r = await resolveInstructions(baseCtx(), fs);
  assert.equal(r.project_id, "explicit-pid");
  const proj = r.layers.find((l) => l.layer === "project");
  assert.ok(proj && proj.source_path.endsWith("explicit-pid.md"));
});

test("16. project_id derivation walks up nested cwd", async () => {
  const fs = memoryFs({
    [`${ROOT}/common.md`]: "C\n",
    [`${ROOT}/roles/coder.md`]: "R\n",
    "/repo/.git": "",
  });
  const r = await resolveInstructions(baseCtx({ cwd: "/repo/a/b/c" }), fs);
  assert.equal(r.project_id, "repo");
});
