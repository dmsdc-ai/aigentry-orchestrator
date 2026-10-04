import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// #1167 isolated SQLite prototype: crash and fault seams (IMPLEMENTATION_CONTRACT 3.B4, 4.6, 4.7, J5, 5.5, 7.3).
// Crashes are ONLY the helper own seam AIGENTRY_REGISTRY_CRASH (os._exit(137) inside its own short-lived child) or
// this suite own short-lived crashed SQLite writer; nothing signals a process group or the host. Oracles read
// copies of the store and assert semantic state (document, generation, meta), never byte-identical D/J after a
// rollback. Against the JSON-only baseline the "contract:" cases fail with FEATURE ABSENT (the gap); the harness
// qualification case needs no subject and must pass everywhere.
function repository(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "bin/dispatch-registry.py"))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, "cannot locate registry beside bin/");
    dir = parent;
  }
  return dir;
}
const repo = repository();
const registry = resolve(process.env.REGISTRY_TRANSITION_TEST_SCRIPT ?? join(repo, "bin/dispatch-registry.py"));
const fixtureBase = resolve(process.env.REGISTRY_SQLITE_FIXTURE_BASE ?? tmpdir());
const windows = process.platform === "win32";
const essential: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" };
for (const key of ["SystemRoot", "WINDIR"]) {
  if (process.env[key]) essential[key] = process.env[key];
}
function pythonExecutable(): string {
  const choices = windows ? ["python"] : process.platform === "darwin" ? ["/opt/homebrew/bin/python3", "python3"] : ["python3"];
  for (const command of choices) {
    const result = spawnSync(command, ["-I", "-B", "-c", "import sys; print(sys.executable)"],
      { env: essential, encoding: "utf8", timeout: 5000 });
    if (result.status === 0 && isAbsolute(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error("Python 3 executable is required for registry SQLite crash acceptance");
}
const python = pythonExecutable();

type Json = Record<string, unknown>;
type Run = SpawnSyncReturns<string>;

const ORACLE = String.raw`
import json,os,pathlib,shutil,sqlite3,sys
META_DDL=("CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), storage_schema INTEGER NOT NULL CHECK(storage_schema=1), "
    "store_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1), mode TEXT NOT NULL CHECK(mode IN (%s)), transition TEXT)"
    % ",".join(chr(39)+m+chr(39) for m in ("MIGRATING","SQLITE","ROLLBACK_PREPARE","JSON")))
REGISTRY_DDL="CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)"
mode=sys.argv[1]
def out(obj):
    print(json.dumps(obj),flush=True)
def copy_store(state,scratch):
    os.makedirs(scratch)
    src=os.path.join(state,"active.db")
    dst=os.path.join(scratch,"copy.db")
    shutil.copyfile(src,dst,follow_symlinks=False)
    if os.path.lexists(src+"-journal"):
        shutil.copyfile(src+"-journal",dst+"-journal",follow_symlinks=False)
    return dst
if mode=="semantic":
    con=sqlite3.connect(copy_store(sys.argv[2],sys.argv[3]),isolation_level=None)
    tables=sorted(r[0] for r in con.execute("select name from sqlite_master where type=?",("table",)))
    out(dict(user_version=con.execute("pragma user_version").fetchone()[0],tables=tables,
        meta=[list(r) for r in con.execute("select id,storage_schema,store_id,epoch,mode,transition from meta")] if "meta" in tables else None,
        documents=[r[0] for r in con.execute("select document from registry")] if "registry" in tables else None,
        integrity=con.execute("pragma integrity_check").fetchone()[0]))
    con.close()
elif mode=="build":
    state=sys.argv[2]
    o=json.loads(sys.argv[3])
    barrier=os.path.join(state,"active.json")
    os.mkdir(barrier,0o700)
    fd=os.open(os.path.join(barrier,"authority.json"),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.write(fd,(json.dumps(dict(format=1,store_id=o["sid"]),separators=(",",":"))+"\n").encode())
    os.close(fd)
    db=os.path.join(state,"active.db")
    os.close(os.open(db,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600))
    con=sqlite3.connect(db,isolation_level=None)
    con.execute("pragma journal_mode=truncate")
    con.execute("begin")
    con.execute(META_DDL)
    con.execute(REGISTRY_DDL)
    con.execute("insert into meta values(1,1,?,1,?,NULL)",(o["sid"],"SQLITE"))
    con.execute("insert into registry values(1,?)",(json.dumps(o["document"]),))
    con.execute("pragma user_version=1")
    con.execute("commit")
    con.close()
    out(dict(built=True))
elif mode=="hot":
    db=os.path.join(sys.argv[2],"active.db")
    con=sqlite3.connect(db,isolation_level=None)
    con.execute("pragma journal_mode=truncate")
    con.execute("pragma cache_size=10")
    con.execute("pragma cache_spill=1")
    before=pathlib.Path(db).read_bytes()
    con.execute("begin immediate")
    doc=json.loads(con.execute("select document from registry").fetchone()[0])
    doc["generation"]=999999
    doc["hot_padding"]="x"*400000
    con.execute("update registry set document=?",(json.dumps(doc),))
    con.execute("create table hot_probe(x)")
    con.execute("insert into hot_probe values(randomblob(400000))")
    out(dict(db_changed=pathlib.Path(db).read_bytes()!=before,journal_bytes=os.path.getsize(db+"-journal")))
    os._exit(137)
elif mode=="roread":
    db=os.path.join(sys.argv[2],"active.db")
    try:
        con=sqlite3.connect(pathlib.Path(db).as_uri()+"?mode=ro",uri=True,isolation_level=None)
        con.execute("select count(*) from registry").fetchone()
        con.close()
        out(dict(error=None))
    except sqlite3.Error as exc:
        out(dict(error=type(exc).__name__+": "+str(exc)))
elif mode=="mutate-many":
    con=sqlite3.connect(os.path.join(sys.argv[2],"active.db"),isolation_level=None)
    con.execute("pragma journal_mode=truncate")
    for sql,params in json.loads(sys.argv[3]):
        con.execute(sql,params)
    con.close()
    out(dict(mutated=True))
`;
const LOCK_PROBE = String.raw`
import json,os,sys
f=open(sys.argv[1],"a+b",buffering=0)
try:
    if os.name=="nt":
        import msvcrt
        f.seek(0)
        msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
        f.seek(0)
        msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
    else:
        import fcntl
        fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        fcntl.flock(f,fcntl.LOCK_UN)
    print(json.dumps(dict(free=True)))
except OSError as exc:
    print(json.dumps(dict(free=False,error=str(exc))))
`;

const LEGACY_OPERATIONS = ["archive-sidecars", "begin-delivery", "check-dedup", "get", "list", "migrate",
  "observe", "prune", "set-gate", "set-lifecycle", "set-transport-result", "snapshot"] as const;
type Op = typeof LEGACY_OPERATIONS[number];
const DIAGNOSTIC: ReadonlySet<string> = new Set(["active.json.lock", "registry-health.log"]);
const STORE_LISTING = ["active.db", "active.db-journal", "active.json", "active.json.lock"];
const SUCCESS = new Set(["proceed", "store_initialized", "DISPATCH_DEDUPLICATED", "DISPATCH_RETRY_HELD", "migrated",
  "archived", "no_sidecars", "retry_held", "deduplicated"]);
const NOW = "2026-10-04T00:00:00Z";
const EMPTY = { schema_version: 2, generation: 0, dispatches: [] };
// 7.3 seams in execution order, with the barrier each leaves behind (3.B4 invalid vs 4.6 init_pending).
const INIT_SEAMS = [
  { seam: "init_after_mkdir", barrier: [], db: "absent" },
  { seam: "init_after_pending", barrier: ["init-pending"], db: "absent" },
  { seam: "init_after_authority", barrier: ["authority.json", "init-pending"], db: "absent" },
  { seam: "init_after_dbcreate", barrier: ["authority.json", "init-pending"], db: "zero" },
  { seam: "init_in_txn", barrier: ["authority.json", "init-pending"], db: "present" },
  { seam: "init_after_commit", barrier: ["authority.json", "init-pending"], db: "committed" },
  { seam: "init_after_verify", barrier: ["authority.json", "init-pending"], db: "committed" },
] as const;
const W_SEAMS = ["w_before_dirsync", "w_dirsync_fail", "w_after_commit"] as const;

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function compact(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
function tree(root: string, skip: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const relName = rel ? `${rel}/${name}` : name;
      if (skip.has(relName)) continue;
      const full = join(root, relName), st = lstatSync(full);
      if (st.isSymbolicLink()) out[relName] = `link:${readlinkSync(full)}`;
      else if (st.isDirectory()) { out[relName] = "dir"; walk(relName); }
      else if (st.isFile()) out[relName] = `file:${sha(readFileSync(full))}`;
      else out[relName] = "other";
    }
  };
  walk("");
  return out;
}
function changes(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter(name => before[name] !== after[name])
    .map(name => `${name}: ${before[name] ?? "absent"} -> ${after[name] ?? "absent"}`);
}
function payloadOf(stdout: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : null;
  } catch { return null; }
}
function names(payload: Json | null, token: string): boolean {
  return payload !== null && (payload.result === token || (typeof payload.detail === "string" && payload.detail.includes(token)));
}
function envelope(result: Run, status: number, name: string): Json {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const payload = payloadOf(result.stdout);
  assert.ok(payload, `stdout is not exactly one JSON object: ${result.stdout}`);
  assert.equal(payload.result, name, result.stdout);
  return payload;
}
// A failed write: exit 9, exactly one JSON error object, completion_fact null and never a success envelope.
function failedWrite(result: Run): Json {
  assert.equal(result.status, 9, result.stdout + result.stderr);
  const payload = payloadOf(result.stdout);
  assert.ok(payload, `stdout is not exactly one JSON object: ${result.stdout}`);
  assert.equal(payload.completion_fact, null);
  assert.equal(SUCCESS.has(String(payload.result)), false, result.stdout);
  return payload;
}
function oracle(mode: string, args: string[], status = 0): Json {
  const result = spawnSync(python, ["-I", "-B", "-c", ORACLE, mode, ...args], { env: essential, encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, status, `oracle ${mode}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as Json;
}
type Semantic = { user_version: number; tables: string[]; meta: unknown[][] | null; documents: string[] | null; integrity: string };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(fixtureBase, "registry-sqlite-crash-"));
  if (!windows) chmodSync(root, 0o700);
  const state = join(root, "state"), home = join(root, "home"), temp = join(root, "tmp");
  for (const dir of [state, home, temp]) mkdirSync(dir, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...essential, HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    DISPATCH_STATE_DIR: state, AIGENTRY_REGISTRY_PROTOTYPE_ROOT: state };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const barrier = join(state, "active.json");
  const paths = { B: barrier, A: join(barrier, "authority.json"), P: join(barrier, "init-pending"), D: join(state, "active.db"),
    J: join(state, "active.db-journal"), L: join(state, "active.json.lock"), H: join(state, "registry-health.log") };
  const sidecars = join(root, "dispatch-helper");
  let scratch = 0;
  // Seam runs may legitimately end in os._exit(137); a signal is never expected.
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}): Run => {
    const result = spawnSync(python, ["-I", "-B", registry, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    t.diagnostic(`RAW ${JSON.stringify({ args, extra, status: result.status, stdout: result.stdout, stderr: result.stderr })}`);
    return result;
  };
  const lockFree = (): boolean => {
    const result = spawnSync(python, ["-I", "-B", "-c", LOCK_PROBE, paths.L], { env: essential, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return (JSON.parse(result.stdout) as { free: boolean }).free;
  };
  const semantic = (): Semantic => oracle("semantic", [state, join(root, `oracle-${++scratch}`)]) as unknown as Semantic;
  const doc = (): Json => {
    const view = semantic();
    assert.ok(view.documents && view.documents.length === 1, JSON.stringify(view));
    return JSON.parse(view.documents[0] ?? "null") as Json;
  };
  return { root, state, paths, sidecars, run, lockFree, semantic, doc };
}
type Fixture = ReturnType<typeof fixture>;

function sidecarDir(f: Fixture) {
  mkdirSync(f.sidecars);
  writeFileSync(join(f.sidecars, "live-worker"), "hash-live\n");
}
function opArgs(f: Fixture, op: Op): string[] {
  switch (op) {
    case "archive-sidecars": return [op, "--dir", f.sidecars];
    case "begin-delivery": return [op, "--sid", "probe", "--ref-hash", "probe-hash", "--now", NOW];
    case "check-dedup": return [op, "--sid", "alpha", "--ref-hash", "h1"];
    case "get": return [op, "--sid", "alpha"];
    case "list": return [op, "--fields", "assigned.sid,lifecycle.state"];
    case "migrate": return [op, "--now", NOW];
    case "observe": return [op, "--sid", "alpha", "--kind", "probe", "--now", NOW];
    case "prune": return [op, "--older-than-seconds", "0", "--now", NOW];
    case "set-gate": return [op, "--sid", "alpha", "--state", "awaiting_user", "--now", NOW];
    case "set-lifecycle": return [op, "--sid", "alpha", "--state", "re_dispatched", "--now", NOW];
    case "set-transport-result": return [op, "--sid", "alpha", "--result", "write_observed", "--now", NOW];
    case "snapshot": return [op];
  }
}
function refused(f: Fixture, args: string[], token?: string): Json | null {
  const sidecars = () => present(f.sidecars) ? JSON.stringify(tree(f.sidecars)) : "absent";
  const before = tree(f.state, DIAGNOSTIC), sidecarsBefore = sidecars();
  const result = f.run(args);
  const payload = payloadOf(result.stdout);
  const observed = {
    status: result.status, stderr: result.stderr, one_object: payload !== null,
    completion_fact: payload && "completion_fact" in payload ? payload.completion_fact : "missing",
    success: SUCCESS.has(String(payload?.result)),
    names_token: token === undefined || names(payload, token),
    changes: changes(before, tree(f.state, DIAGNOSTIC)), sidecars_kept: sidecars() === sidecarsBefore,
  };
  assert.deepEqual(observed, { status: 9, stderr: "", one_object: true, completion_fact: null, success: false,
    names_token: true, changes: [], sidecars_kept: true }, `${args.join(" ")} (want ${token ?? "any 9"}): ${result.stdout}`);
  return payload;
}
function featureGap(f: Fixture): void {
  const listed = f.run(["--list-ops"]);
  assert.ok(listed.stdout.split(/\r?\n/).includes("init-store"),
    "FEATURE ABSENT (baseline gap): the subject does not advertise init-store; this crash oracle needs a candidate");
}
// Native Windows refuses new init before any file (4.1, 6.6); no SQLite crash evidence is claimed there.
function windowsInitRefused(f: Fixture): void {
  const before = tree(f.state);
  const result = f.run(["init-store"]);
  assert.equal(result.status, 9, result.stdout);
  assert.ok(names(payloadOf(result.stdout), "unsupported_platform"), result.stdout);
  assert.deepEqual(changes(before, tree(f.state)), []);
  assert.equal(present(f.paths.H), false);
}
function initStore(f: Fixture): string | null {
  featureGap(f);
  if (windows) { windowsInitRefused(f); return null; }
  const sid = String(envelope(f.run(["init-store"]), 0, "store_initialized").store_id);
  assert.match(sid, /^[0-9a-f]{32}$/);
  return sid;
}
function assertStore(f: Fixture, sid: string): Json {
  assert.deepEqual(readdirSync(f.state).filter(name => name !== "registry-health.log").sort(), STORE_LISTING);
  assert.deepEqual(readdirSync(f.paths.B).sort(), ["authority.json"]);
  assert.equal(readFileSync(f.paths.A, "utf8"), compact({ format: 1, store_id: sid }));
  const journal = lstatSync(f.paths.J);
  assert.ok(journal.isFile() && journal.size === 0, `journal not a zero-byte regular file: ${journal.size}`);
  const view = f.semantic();
  assert.deepEqual({ user_version: view.user_version, tables: view.tables, meta: view.meta, integrity: view.integrity },
    { user_version: 1, tables: ["meta", "registry"], meta: [[1, 1, sid, 1, "SQLITE", null]], integrity: "ok" });
  return f.doc();
}
function sids(doc: Json): unknown[] {
  return (doc.dispatches as Json[]).map(r => (r.assigned as Json).sid);
}
function seededStore(f: Fixture): string | null {
  const sid = initStore(f);
  if (sid) envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 0, "proceed");
  return sid;
}

test("receipt: crash seams, subject and fixture base", t => {
  t.diagnostic(`registry=${registry}; sha256=${sha(readFileSync(registry))}; fixtureBase=${fixtureBase}`);
  t.diagnostic(`init seams=${INIT_SEAMS.map(s => s.seam).join(",")}; write seams=${W_SEAMS.join(",")}`);
  t.diagnostic("process-kill and seam crashes are consistency evidence only, never power-loss proof (J5, G1)");
  const f = fixture(t);
  if (!windows) assert.equal(lstatSync(f.root).mode & 0o777, 0o700);
});

test("harness qualification: independent store oracles and a staged hot journal (no subject involved)", t => {
  const f = fixture(t);
  const sid = "00112233445566778899aabbccddeeff";
  const document = { schema_version: 2, generation: 41, dispatches: [] };
  oracle("build", [f.state, JSON.stringify({ sid, document })]);
  const clean = f.semantic();
  assert.deepEqual({ ...clean, documents: (clean.documents ?? []).map(text => JSON.parse(text) as unknown) },
    { user_version: 1, tables: ["meta", "registry"], meta: [[1, 1, sid, 1, "SQLITE", null]], documents: [document], integrity: "ok" });
  const hot = oracle("hot", [f.state], 137);
  assert.equal(hot.db_changed, true, "staged writer did not spill pages into active.db before dying");
  assert.ok(Number(hot.journal_bytes) > 0, "staged writer left no journal");
  const before = tree(f.state);
  const ro = oracle("roread", [f.state]);
  assert.notEqual(ro.error, null, "a mode=ro reader read through a hot journal");
  assert.deepEqual(changes(before, tree(f.state)), [], "the read-only probe changed D/J");
  const recovered = f.semantic();
  assert.deepEqual(recovered.tables, ["meta", "registry"], "copy rollback left the uncommitted table");
  assert.deepEqual(JSON.parse(recovered.documents?.[0] ?? "null"), document);
  assert.equal(recovered.integrity, "ok");
  assert.deepEqual(changes(before, tree(f.state)), [], "the copy oracle changed D/J");
});

for (const spec of INIT_SEAMS) {
  for (const kind of ["crash", "fault"] as const) {
    test(`contract: init seam ${spec.seam} (${kind}) leaves ${spec.barrier.length === 2 ? "a resumable init_pending" : "an invalid barrier"} (B4, 4.6, 7.3)`, t => {
      const f = fixture(t);
      featureGap(f);
      if (windows) { windowsInitRefused(f); return; }
      sidecarDir(f);
      const result = f.run(["init-store"], kind === "crash" ? { AIGENTRY_REGISTRY_CRASH: spec.seam } : { AIGENTRY_REGISTRY_FAULT: spec.seam });
      if (kind === "crash") {
        assert.equal(result.status, 137, result.stdout + result.stderr);
        assert.equal(result.stdout, "", "a crashed init emitted an envelope");
      } else {
        failedWrite(result);
      }
      assert.ok(lstatSync(f.paths.B).isDirectory());
      assert.deepEqual(readdirSync(f.paths.B).sort(), [...spec.barrier]);
      const pendingBytes = present(f.paths.P) ? readFileSync(f.paths.P, "utf8") : null;
      const sid = pendingBytes === null ? null : String((JSON.parse(pendingBytes) as Json).store_id);
      if (pendingBytes !== null) {
        assert.match(sid ?? "", /^[0-9a-f]{32}$/);
        assert.equal(pendingBytes, compact({ format: 1, intent: "init-store", store_id: sid }));
      }
      if (present(f.paths.A)) assert.equal(readFileSync(f.paths.A, "utf8"), compact({ format: 1, store_id: sid }));
      if (spec.db === "absent") assert.equal(present(f.paths.D), false);
      if (spec.db === "zero") assert.equal(lstatSync(f.paths.D).size, 0);
      if (spec.db === "present") assert.ok(lstatSync(f.paths.D).isFile());
      if (spec.db === "committed") {
        const view = f.semantic();
        assert.deepEqual({ user_version: view.user_version, tables: view.tables, meta: view.meta },
          { user_version: 1, tables: ["meta", "registry"], meta: [[1, 1, sid, 1, "SQLITE", null]] });
        assert.deepEqual(JSON.parse(view.documents?.[0] ?? "null"), EMPTY);
      }
      assert.equal(f.lockFree(), true, "lock still held after the seam");
      const pending = spec.barrier.length === 2;
      for (const op of LEGACY_OPERATIONS) refused(f, opArgs(f, op), pending ? undefined : "barrier incomplete");
      if (!pending) {
        refused(f, ["init-store"], "barrier incomplete");
        assert.deepEqual(readdirSync(f.paths.B).sort(), [...spec.barrier], "partial barrier was repaired or deleted");
        return;
      }
      const authority = readFileSync(f.paths.A);
      const resumed = envelope(f.run(["init-store"]), 0, "store_initialized");
      assert.equal(resumed.store_id, sid, "resume must keep the pending store_id");
      assert.equal(resumed.generation, 0);
      assert.deepEqual(readFileSync(f.paths.A), authority);
      assert.deepEqual(assertStore(f, sid ?? ""), EMPTY);
      envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 0, "proceed");
      assert.equal(assertStore(f, sid ?? "").generation, 1);
    });
  }
}

const MUTATORS: Record<string, string[]> = {
  "begin-delivery": ["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--now", NOW],
  observe: ["observe", "--sid", "alpha", "--kind", "probe", "--now", NOW],
  "set-lifecycle": ["set-lifecycle", "--sid", "alpha", "--state", "re_dispatched", "--now", NOW],
  "set-gate": ["set-gate", "--sid", "alpha", "--state", "awaiting_user", "--now", NOW],
  "set-transport-result": ["set-transport-result", "--sid", "alpha", "--result", "write_observed", "--now", NOW],
  prune: ["prune", "--older-than-seconds", "0", "--now", NOW],
};

test("contract: a checked directory-fsync failure rolls every mutator back semantically (J5 w_dirsync_fail)", async t => {
  for (const [name, args] of Object.entries(MUTATORS)) {
    await t.test(name, st => {
      const f = fixture(st);
      const sid = seededStore(f);
      if (!sid) return;
      const before = f.doc();
      failedWrite(f.run(args, { AIGENTRY_REGISTRY_FAULT: "w_dirsync_fail" }));
      assert.deepEqual(f.doc(), before, "document or generation changed after the rolled-back write");
      assert.equal(f.lockFree(), true);
      const retried = f.run(args);
      assert.equal(retried.status, 0, retried.stdout + retried.stderr);
      assert.equal(assertStore(f, sid).generation, Number(before.generation) + 1);
    });
  }
});

test("contract: w_before_dirsync fault rolls back and a crash there loses only the uncommitted write (J4, J5)", async t => {
  await t.test("fault", st => {
    const f = fixture(st);
    const sid = seededStore(f);
    if (!sid) return;
    const before = f.doc();
    failedWrite(f.run(MUTATORS["begin-delivery"] ?? [], { AIGENTRY_REGISTRY_FAULT: "w_before_dirsync" }));
    assert.deepEqual(f.doc(), before);
    assert.equal(f.lockFree(), true);
  });
  await t.test("crash", st => {
    const f = fixture(st);
    const sid = seededStore(f);
    if (!sid) return;
    const before = f.doc();
    const crashed = f.run(MUTATORS["begin-delivery"] ?? [], { AIGENTRY_REGISTRY_CRASH: "w_before_dirsync" });
    assert.equal(crashed.status, 137, crashed.stdout + crashed.stderr);
    assert.equal(crashed.stdout, "", "a crashed writer emitted an envelope");
    assert.deepEqual(f.doc(), before, "uncommitted write survived the crash");
    const read = f.run(["snapshot"]);
    if (read.status === 0) assert.equal(JSON.parse(read.stdout).generation, before.generation);
    else assert.ok(read.status === 9 && names(payloadOf(read.stdout), "hot journal"), read.stdout);
    const recovered = f.run(MUTATORS.observe ?? []);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.equal(recovered.stdout + recovered.stderr, "");
    const after = assertStore(f, sid);
    assert.equal(after.generation, Number(before.generation) + 1);
    assert.deepEqual(sids(after), ["alpha"]);
    assert.equal(f.run(["snapshot"]).status, 0);
  });
});

test("contract: w_after_commit is an ambiguous commit that never yields a second delivery (J5, 6.5)", async t => {
  await t.test("crash after COMMIT", st => {
    const f = fixture(st);
    const sid = seededStore(f);
    if (!sid) return;
    const crashed = f.run(MUTATORS["begin-delivery"] ?? [], { AIGENTRY_REGISTRY_CRASH: "w_after_commit" });
    assert.equal(crashed.status, 137, crashed.stdout + crashed.stderr);
    assert.equal(crashed.stdout, "", "no proceed may be emitted for an unacknowledged commit");
    const doc = assertStore(f, sid);
    assert.equal(doc.generation, 2);
    assert.deepEqual(sids(doc), ["alpha", "beta"]);
    envelope(f.run(MUTATORS["begin-delivery"] ?? []), 7, "DISPATCH_RETRY_HELD");
  });
  await t.test("fault after COMMIT", st => {
    const f = fixture(st);
    const sid = seededStore(f);
    if (!sid) return;
    failedWrite(f.run(MUTATORS["begin-delivery"] ?? [], { AIGENTRY_REGISTRY_FAULT: "w_after_commit" }));
    assert.equal(f.lockFree(), true);
    const doc = f.doc();
    st.diagnostic(`ambiguous commit landed generation ${String(doc.generation)}`);
    assert.ok(doc.generation === 1 || doc.generation === 2, JSON.stringify(doc));
    assert.deepEqual(sids(doc), doc.generation === 2 ? ["alpha", "beta"] : ["alpha"]);
    const again = f.run(MUTATORS["begin-delivery"] ?? []);
    assert.equal(again.status, doc.generation === 2 ? 7 : 0, again.stdout);
    assertStore(f, sid);
  });
});

test("contract: hot journal is refused to readers and recovered by the next locked writer (5.5, 7.5)", t => {
  const f = fixture(t);
  const sid = seededStore(f);
  if (!sid) return;
  const before = f.doc();
  const hot = oracle("hot", [f.state], 137);
  assert.equal(hot.db_changed, true);
  for (const args of [["snapshot"], ["get", "--sid", "alpha"], ["list"], ["check-dedup", "--sid", "alpha", "--ref-hash", "h1"]]) {
    refused(f, args, "hot journal");
  }
  const observed = f.run(MUTATORS.observe ?? []);
  assert.equal(observed.status, 0, observed.stdout + observed.stderr);
  assert.equal(observed.stdout + observed.stderr, "");
  const after = assertStore(f, sid);
  assert.equal(after.generation, Number(before.generation) + 1);
  assert.equal("hot_padding" in after, false, "uncommitted bytes survived recovery");
  const record = (after.dispatches as Json[])[0] ?? {};
  assert.equal((record.last_observation as Json).kind, "probe");
  const snapshot = f.run(["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stdout);
  assert.deepEqual(JSON.parse(snapshot.stdout), after);
});

// Decision r2.1: committed-resume validation must reject a tampered committed store and keep the pending marker.
const RESUME_TAMPERS: { name: string; statements: [string, unknown[]][] }[] = [
  { name: "registry row id rewritten to 2", statements: [["pragma ignore_check_constraints=1", []], ["update registry set id=2", []]] },
  { name: "registry rebuilt without CHECK(id=1)", statements: [["alter table registry rename to registry_old", []],
    ["create table registry(id INTEGER PRIMARY KEY, document TEXT NOT NULL)", []],
    ["insert into registry select id,document from registry_old", []], ["drop table registry_old", []]] },
];
for (const seam of ["init_after_commit", "init_after_verify"] as const) {
  for (const tamper of RESUME_TAMPERS) {
    test(`contract: resume after ${seam} crash refuses a committed store with ${tamper.name} (decision r2.1)`, t => {
      const f = fixture(t);
      featureGap(f);
      if (windows) { windowsInitRefused(f); return; }
      const crashed = f.run(["init-store"], { AIGENTRY_REGISTRY_CRASH: seam });
      assert.equal(crashed.status, 137, crashed.stdout + crashed.stderr);
      oracle("mutate-many", [f.state, JSON.stringify(tamper.statements)]);
      const barrier = tree(f.paths.B), view = f.semantic();
      failedWrite(f.run(["init-store"]));
      assert.deepEqual(tree(f.paths.B), barrier, "pending marker or authority changed");
      assert.deepEqual(f.semantic(), view, "store content changed");
      refused(f, ["snapshot"]);
    });
  }
}
