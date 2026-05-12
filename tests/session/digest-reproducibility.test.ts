// ADR-MF #10 §3.3 — canonical-bytes determinism end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Role, type SessionContext } from "../../src/session/types.js";
import { resolveInstructions } from "../../src/session/resolve-instructions.js";
import { memoryFs } from "../../src/session/virtual-fs.js";
import { canonicalBytes, sha256Hex } from "../../src/session/persistence/canonical-bytes.js";
import { buildLayeredFs } from "../fixtures/adr-mf/memory-fs-builder.js";

const ROOT = "/instr-R";
const baseCtx = () => ({ role: Role.coder, cwd: "/nowhere", task_prompt: "TASK\n", task_source_path: "/d/t.md", instructions_root: ROOT });

test("R1 — identical inputs produce identical digest", async () => {
  const fs = buildLayeredFs({ root: ROOT, layers: { common: "COMMON\n", roles: { [Role.coder]: "CODER\n" } } });
  const a = await resolveInstructions(baseCtx(), fs);
  const b = await resolveInstructions(baseCtx(), fs);
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
  assert.equal(a.effective_prompt, b.effective_prompt);
});

test("R2 — CRLF / LF / NFD all normalize to same digest", async () => {
  const NFC = "\u00e9 résumé\n";
  const NFD = "\u0065\u0301 r\u0065\u0301sum\u0065\u0301\n";
  const a = await resolveInstructions(baseCtx(), buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: NFC } } }));
  const b = await resolveInstructions(baseCtx(), buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: NFC.replace(/\n/g, "\r\n") } } }));
  const c = await resolveInstructions(baseCtx(), buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: NFD } } }));
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
  assert.equal(a.effective_prompt_digest, c.effective_prompt_digest);
});

test("R3 — leading BOM stripped (digest equals BOM-less file)", async () => {
  const a = await resolveInstructions(baseCtx(), buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: "CODER\n" } } }));
  const b = await resolveInstructions(baseCtx(), buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: "\uFEFFCODER\n" } } }));
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
});

test("R4 — SessionContext canonicalBytes is key-order-independent", () => {
  const ctxA: SessionContext = { session_id: "S", role: Role.coder, cwd: "/w", task_id: "T", effective_prompt_digest: "d", effective_prompt_path: "/p", layers: [], spawn_chain: [], depth: 0, created_at: "2026-05-12T00:00:00+00:00" };
  const shuffled = Object.fromEntries(Object.entries(ctxA).sort(() => -1)) as unknown as SessionContext;
  assert.notDeepEqual(Object.keys(ctxA), Object.keys(shuffled));
  assert.equal(sha256Hex(canonicalBytes(ctxA)), sha256Hex(canonicalBytes(shuffled)));
});

test("R5 — layer registration order doesn't affect digest", async () => {
  const forward = memoryFs({ [`${ROOT}/common.md`]: "C\n", [`${ROOT}/projects/myproj.md`]: "P\n", [`${ROOT}/roles/coder.md`]: "R\n", "/work/myproj/.git": "" });
  const reverse = memoryFs([[`${ROOT}/roles/coder.md`, "R\n"], [`${ROOT}/projects/myproj.md`, "P\n"], ["/work/myproj/.git", ""], [`${ROOT}/common.md`, "C\n"]]);
  const ctx = { ...baseCtx(), cwd: "/work/myproj" };
  const a = await resolveInstructions(ctx, forward);
  const b = await resolveInstructions(ctx, reverse);
  assert.equal(a.effective_prompt_digest, b.effective_prompt_digest);
  assert.deepEqual(a.layers.map((l) => l.layer), b.layers.map((l) => l.layer));
});
