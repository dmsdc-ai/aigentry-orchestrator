// ADR-MF #10 §3.5 — persist→load cycle composing #14 + #115 with resolver digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Role, type SessionContext } from "../../src/session/types.js";
import { loadContext, PersistError, persistContext, recoverCrashedWrites, type PathConfig } from "../../src/session/persist-context.js";
import { canonicalBytes, sha256Hex } from "../../src/session/persistence/canonical-bytes.js";
import { resolveInstructions } from "../../src/session/resolve-instructions.js";
import { buildLayeredFs } from "../fixtures/adr-mf/memory-fs-builder.js";

const mkRoot = async (lbl: string): Promise<PathConfig> => ({ sessionsRoot: await fs.mkdtemp(join(tmpdir(), `mf10-${lbl}-`)) });
const rmRoot = (p: PathConfig) => fs.rm(p.sessionsRoot, { recursive: true, force: true });

async function realCtx(sid: string): Promise<SessionContext> {
  const ROOT = "/instr-PP";
  const vfs = buildLayeredFs({ root: ROOT, layers: { common: "C\n", roles: { [Role.coder]: "CODER\n" } } });
  const r = await resolveInstructions({ role: Role.coder, cwd: "/nowhere", task_prompt: "T\n", task_source_path: "/d/t.md", instructions_root: ROOT }, vfs);
  return { session_id: sid, role: Role.coder, cwd: "/tmp/work", task_id: `T-${sid}`, effective_prompt_digest: r.effective_prompt_digest, effective_prompt_path: "/snap/effective_prompt.md", layers: r.layers, spawn_chain: [], depth: 0, created_at: "2026-05-12T00:00:00+00:00" };
}

test("P1 — resolver→persist→load preserves digest and round-trips", async () => {
  const paths = await mkRoot("P1");
  try {
    const ctx = await realCtx("sess-P1");
    const r = await persistContext(ctx, paths);
    const loaded = await loadContext(ctx.session_id, paths);
    assert.deepEqual(loaded, ctx);
    assert.equal(r.sha256, sha256Hex(canonicalBytes(loaded)));
    assert.equal(loaded!.effective_prompt_digest, ctx.effective_prompt_digest);
  } finally { await rmRoot(paths); }
});

test("P2 — concurrent same-id same-bytes spawns → 1 wrote, 3 alreadyPersisted, no tmp residue", async () => {
  const paths = await mkRoot("P2");
  try {
    const ctx = await realCtx("sess-P2");
    const settled = await Promise.allSettled([persistContext(ctx, paths), persistContext(ctx, paths), persistContext(ctx, paths), persistContext(ctx, paths)]);
    for (const s of settled) assert.equal(s.status, "fulfilled");
    const flags = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value.alreadyPersisted] : []));
    assert.equal(flags.filter((f) => f).length, 3);
    assert.equal(flags.filter((f) => !f).length, 1);
    assert.deepEqual(await fs.readdir(join(paths.sessionsRoot, "sess-P2")), ["context.json"]);
  } finally { await rmRoot(paths); }
});

test("P3 — crash recovery sweeps multi-session tmp stubs + writes one log line", async () => {
  const paths = await mkRoot("P3");
  try {
    for (const sid of ["A", "B"]) {
      const dir = join(paths.sessionsRoot, sid);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, `context.json.tmp.${sid}.111`), "x");
      await fs.writeFile(join(dir, `context.json.tmp.${sid}.222`), "x");
    }
    await fs.writeFile(join(paths.sessionsRoot, "B", "context.json.tmp.B.333"), "x");
    const report = await recoverCrashedWrites(paths);
    assert.equal(report.deleted.length, 5);
    const log = await fs.readFile(join(paths.sessionsRoot, ".recovery.log"), "utf8");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).deleted.length, 5);
  } finally { await rmRoot(paths); }
});

test("P4 — corrupt one snapshot byte; loadContext flags only that id", async () => {
  const paths = await mkRoot("P4");
  try {
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    for (const id of ids) await persistContext(await realCtx(id), paths);
    const target = join(paths.sessionsRoot, "s3", "context.json");
    const orig = await fs.readFile(target, "utf8");
    const bad = orig.replace('"role":"coder"', '"role":"tester"');
    assert.notEqual(bad, orig);
    writeFileSync(target, bad);
    await assert.rejects(() => loadContext("s3", paths), (e: unknown) => e instanceof PersistError && e.code === "ERR_DIGEST_MISMATCH");
    for (const id of ids.filter((x) => x !== "s3")) assert.equal((await loadContext(id, paths))?.session_id, id);
  } finally { await rmRoot(paths); }
});

test("P5 — canonical sha256 stable across persist→load (no drift)", async () => {
  const paths = await mkRoot("P5");
  try {
    const ctx = await realCtx("sess-P5");
    const r = await persistContext(ctx, paths);
    const loaded = await loadContext(ctx.session_id, paths);
    assert.ok(loaded);
    assert.equal(sha256Hex(canonicalBytes(loaded)), r.sha256);
    assert.ok(existsSync(r.path));
  } finally { await rmRoot(paths); }
});
