// ADR-MF #5 — persist-context tests (T1–T12 per SPEC §8).
// SPEC: docs/specs/2026-05-12-context-persist.md
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultPathConfig,
  loadContext,
  PersistError,
  persistContext,
  recoverCrashedWrites,
  type PathConfig,
} from "../../src/session/persist-context.js";
import { canonicalBytes, sha256Hex } from "../../src/session/persistence/index.js";
import { Role, type SessionContext } from "../../src/session/types.js";

async function mkRoot(label: string): Promise<PathConfig> {
  return { sessionsRoot: await fs.mkdtemp(path.join(os.tmpdir(), `aigentry-mf5-${label}-`)) };
}
const rmRoot = (p: PathConfig) => fs.rm(p.sessionsRoot, { recursive: true, force: true });

function fixture(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    session_id: "sess-T1",
    role: Role.coder,
    cwd: "/tmp/work",
    task_id: "task-1",
    parent_id: "sess-root",
    effective_prompt_digest: "deadbeef".repeat(8),
    effective_prompt_path: "/tmp/work/prompt.md",
    layers: [{ layer: "common", source_path: "/c.md", content_sha256: "a".repeat(64), read_at: "2026-05-12T00:00:00+00:00" }],
    spawn_chain: ["sess-root"],
    depth: 1,
    created_at: "2026-05-12T00:00:00+00:00",
    ...overrides,
  };
}

const isCode = (code: string) => (err: unknown) =>
  err instanceof PersistError && err.code === code;

const readIdx = async (p: PathConfig) =>
  JSON.parse(await fs.readFile(path.join(p.sessionsRoot, "index.json"), "utf8"));

test("T1 round-trip: persistContext → loadContext deep-equal + sha256 match", async () => {
  const paths = await mkRoot("t1");
  try {
    const ctx = fixture();
    const result = await persistContext(ctx, paths);
    assert.equal(result.alreadyPersisted, false);
    const loaded = await loadContext(ctx.session_id, paths);
    assert.deepEqual(loaded, ctx);
    assert.equal(result.sha256, sha256Hex(canonicalBytes(loaded)));
  } finally { await rmRoot(paths); }
});

test("T2 idempotent re-persist: same bytes ×2 → alreadyPersisted, mtime unchanged, 1 index entry", async () => {
  const paths = await mkRoot("t2");
  try {
    const ctx = fixture({ session_id: "sess-T2" });
    const r1 = await persistContext(ctx, paths);
    const mtime1 = statSync(r1.path).mtimeMs;
    await new Promise((res) => setTimeout(res, 20));
    const r2 = await persistContext(ctx, paths);
    assert.equal(r2.alreadyPersisted, true);
    assert.equal(r2.sha256, r1.sha256);
    assert.equal(statSync(r1.path).mtimeMs, mtime1);
    assert.equal((await readIdx(paths)).sessions.length, 1);
  } finally { await rmRoot(paths); }
});

test("T3 mutation blocked: same id + different role → MUTATION_BLOCKED, on-disk byte-identical", async () => {
  const paths = await mkRoot("t3");
  try {
    const r1 = await persistContext(fixture({ session_id: "sess-T3" }), paths);
    const before = await fs.readFile(r1.path);
    await assert.rejects(
      () => persistContext(fixture({ session_id: "sess-T3", role: Role.tester }), paths),
      isCode("MUTATION_BLOCKED"),
    );
    assert.deepEqual(await fs.readFile(r1.path), before);
  } finally { await rmRoot(paths); }
});

test("T4 crash mid-write: pre-place tmp stub, recoverCrashedWrites sweeps + appends JSONL", async () => {
  const paths = await mkRoot("t4");
  try {
    const dir = path.join(paths.sessionsRoot, "sess-T4");
    await fs.mkdir(dir, { recursive: true });
    const stub = path.join(dir, `context.json.tmp.sess-T4.${process.pid}`);
    await fs.writeFile(stub, "partial");
    const report = await recoverCrashedWrites(paths);
    assert.equal(report.deleted.length, 1);
    assert.equal(report.deleted[0], stub);
    assert.equal(existsSync(stub), false);
    const log = await fs.readFile(path.join(paths.sessionsRoot, ".recovery.log"), "utf8");
    assert.deepEqual(JSON.parse(log.trim()).deleted, [stub]);
  } finally { await rmRoot(paths); }
});

test("T5 concurrent spawns, different parents: 8 entries, sorted, round-trip clean", async () => {
  const paths = await mkRoot("t5");
  try {
    const ids = Array.from({ length: 8 }, (_, i) => `sess-T5-${i}`);
    await Promise.all(ids.map((id) => persistContext(fixture({ session_id: id, parent_id: `parent-${id}` }), paths)));
    const idx = await readIdx(paths);
    assert.equal(idx.sessions.length, 8);
    const onDiskIds = idx.sessions.map((e: { id: string }) => e.id);
    assert.deepEqual(onDiskIds, [...onDiskIds].sort());
    for (const id of ids) {
      const loaded = await loadContext(id, paths);
      assert.equal(loaded?.session_id, id);
    }
  } finally { await rmRoot(paths); }
});

test("T6 concurrent same-id different-bytes: exactly one wins, no torn write", async () => {
  const paths = await mkRoot("t6");
  try {
    const a = fixture({ session_id: "sess-T6", role: Role.coder });
    const b = fixture({ session_id: "sess-T6", role: Role.tester });
    const settled = await Promise.allSettled([persistContext(a, paths), persistContext(b, paths)]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
    assert.equal(settled.filter((s) => s.status === "rejected").length, 1);
    for (const s of settled) {
      if (s.status === "rejected") {
        assert.ok(s.reason instanceof PersistError);
        assert.equal((s.reason as PersistError).code, "MUTATION_BLOCKED");
      }
    }
    assert.ok(await loadContext("sess-T6", paths));
  } finally { await rmRoot(paths); }
});

test("T7 path canonicalization: symlink + .. → realpath in index, load via un-normalized works", async (t) => {
  const paths = await mkRoot("t7-real");
  const realRoot = await fs.realpath(paths.sessionsRoot);
  const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "aigentry-mf5-t7-link-"));
  try {
    const linkPath = path.join(linkParent, "sessions-symlink");
    await fs.mkdir(path.join(paths.sessionsRoot, "sub"));
    await fs.symlink(paths.sessionsRoot, linkPath, "dir");
    const linked: PathConfig = { sessionsRoot: `${linkPath}${path.sep}sub${path.sep}..` };
    const roots = [linked, paths, { sessionsRoot: realRoot }, { sessionsRoot: linkPath }];
    const ctx = fixture({ session_id: "sess-T7" });
    const first = await persistContext(ctx, linked);
    assert.equal(first.alreadyPersisted, false);
    const target = path.join(paths.sessionsRoot, ctx.session_id, "context.json");
    const expected = process.platform === "win32" ? await fs.realpath(target) : realpathSync(target);
    const before = await fs.readFile(target);
    const mtime = statSync(target).mtimeMs;
    if (process.platform === "win32") {
      t.diagnostic(JSON.stringify({ root: paths.sessionsRoot, generic: realpathSync(paths.sessionsRoot), native: realpathSync.native(paths.sessionsRoot), promise: realRoot }));
    }
    await new Promise((res) => setTimeout(res, 20));
    for (const root of roots) {
      const loaded = await loadContext(ctx.session_id, root);
      assert.deepEqual(loaded, ctx);
      assert.equal(sha256Hex(canonicalBytes(loaded)), first.sha256);
      const retry = await persistContext(ctx, root);
      assert.equal(retry.alreadyPersisted, true);
      assert.equal(retry.sha256, first.sha256);
      assert.deepEqual(await fs.readFile(target), before);
      assert.equal(statSync(target).mtimeMs, mtime);
      const idx = await readIdx(root);
      assert.equal(idx.sessions.length, 1);
      assert.equal(idx.sessions[0].id, ctx.session_id);
      assert.equal(idx.sessions[0].path, expected);
      assert.equal(idx.sessions[0].sha256, first.sha256);
    }
    await assert.rejects(
      () => persistContext({ ...ctx, role: Role.tester }, { sessionsRoot: realRoot }),
      isCode("MUTATION_BLOCKED"),
    );
    assert.deepEqual(await fs.readFile(target), before);
    assert.equal(statSync(target).mtimeMs, mtime);
    assert.equal((await readIdx(paths)).sessions.length, 1);
  } finally {
    await fs.rm(linkParent, { recursive: true, force: true });
    await rmRoot(paths);
  }
});

test("T8 missing session: loadContext returns null, no throw", async () => {
  const paths = await mkRoot("t8");
  try {
    assert.equal(await loadContext("does-not-exist", paths), null);
  } finally { await rmRoot(paths); }
});

test("T9 corrupt context.json: hand-edit one byte → loadContext throws ERR_DIGEST_MISMATCH", async () => {
  const paths = await mkRoot("t9");
  try {
    const r = await persistContext(fixture({ session_id: "sess-T9" }), paths);
    const original = await fs.readFile(r.path, "utf8");
    const corrupted = original.replace('"role":"coder"', '"role":"tester"');
    assert.notEqual(corrupted, original);
    writeFileSync(r.path, corrupted);
    await assert.rejects(() => loadContext("sess-T9", paths), isCode("ERR_DIGEST_MISMATCH"));
  } finally { await rmRoot(paths); }
});

test("T10 invalid session_id: '' / 'a/b' / '..' / leading-dot / NUL → ERR_INVALID_SESSION_ID", async () => {
  const paths = await mkRoot("t10");
  try {
    for (const bad of ["", "a/b", "..", ".hidden", "with\u0000nul"]) {
      await assert.rejects(
        () => persistContext(fixture({ session_id: bad }), paths),
        isCode("ERR_INVALID_SESSION_ID"),
      );
    }
    assert.equal(existsSync(path.join(paths.sessionsRoot, "index.json")), false);
  } finally { await rmRoot(paths); }
});

test("T11 invalid context (missing role): throws ERR_INVALID_CONTEXT, no directory created", async () => {
  const paths = await mkRoot("t11");
  try {
    const bad = fixture({ session_id: "sess-T11" });
    (bad as unknown as { role: string }).role = "";
    await assert.rejects(() => persistContext(bad, paths), isCode("ERR_INVALID_CONTEXT"));
    assert.equal(existsSync(path.join(paths.sessionsRoot, "sess-T11")), false);
  } finally { await rmRoot(paths); }
});

test("T12 corrupt index.json: persist a 2nd id throws ERR_INDEX_CORRUPT; new context.json survives sweep", async () => {
  const paths = await mkRoot("t12");
  try {
    await persistContext(fixture({ session_id: "sess-T12-a" }), paths);
    writeFileSync(path.join(paths.sessionsRoot, "index.json"), "{not:valid}");
    await assert.rejects(
      () => persistContext(fixture({ session_id: "sess-T12-b" }), paths),
      isCode("ERR_INDEX_CORRUPT"),
    );
    const newCtx = path.join(paths.sessionsRoot, "sess-T12-b", "context.json");
    assert.equal(existsSync(newCtx), true);
    assert.equal((await recoverCrashedWrites(paths)).deleted.length, 0);
    assert.equal(existsSync(newCtx), true);
  } finally { await rmRoot(paths); }
});

test("T13 #561 high-concurrency spawns: index-lock serializes — no shared-tmp ENOENT, no lost index entries", async () => {
  // Repros the #561 flake: concurrent persists collided on the shared index tmp
  // (`index.json.tmp.__index__.<pid>`) → rename ENOENT, and racing read-modify-write
  // dropped index entries — both because index-lock acquisition mis-swept an in-flight
  // (empty) lock as stale. Several high-fanout rounds make the race reliably surface.
  const N = 24;
  const ROUNDS = 12;
  for (let r = 0; r < ROUNDS; r++) {
    const paths = await mkRoot(`t13-${r}`);
    try {
      const ids = Array.from({ length: N }, (_, i) => `sess-T13-${i}`);
      const settled = await Promise.allSettled(
        ids.map((id) => persistContext(fixture({ session_id: id, parent_id: `parent-${id}` }), paths)),
      );
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      assert.deepEqual(
        rejected.map((s) => String((s.reason as Error)?.message ?? s.reason)),
        [],
        `round ${r}: concurrent persists must all succeed (no ENOENT)`,
      );
      const idx = await readIdx(paths);
      assert.equal(idx.sessions.length, N, `round ${r}: index lost entries (read-modify-write race)`);
    } finally { await rmRoot(paths); }
  }
});

test("defaultPathConfig honors AIGENTRY_SESSIONS_ROOT env override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aigentry-mf5-env-"));
  const prev = process.env["AIGENTRY_SESSIONS_ROOT"];
  process.env["AIGENTRY_SESSIONS_ROOT"] = tmp;
  try {
    const expected = process.platform === "win32" ? await fs.realpath(tmp) : realpathSync(tmp);
    assert.equal(defaultPathConfig().sessionsRoot, expected);
    const linkPath = path.join(tmp, "sessions-symlink");
    const realRoot = path.join(tmp, "sessions");
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, linkPath, "dir");
    process.env["AIGENTRY_SESSIONS_ROOT"] = linkPath;
    assert.equal(defaultPathConfig().sessionsRoot, process.platform === "win32" ? await fs.realpath(realRoot) : realpathSync(realRoot));
    const missing = path.join(tmp, "missing-sessions");
    process.env["AIGENTRY_SESSIONS_ROOT"] = path.relative(process.cwd(), missing);
    assert.equal(defaultPathConfig().sessionsRoot, path.resolve(missing));
    assert.equal(existsSync(missing), false);
  } finally {
    if (prev === undefined) delete process.env["AIGENTRY_SESSIONS_ROOT"];
    else process.env["AIGENTRY_SESSIONS_ROOT"] = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
