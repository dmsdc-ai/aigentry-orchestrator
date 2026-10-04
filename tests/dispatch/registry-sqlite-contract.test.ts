import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// #1167 isolated SQLite prototype: contract oracles for IMPLEMENTATION_CONTRACT sections 4-7 as amended by the
// controller corrections 1-8. Every case drives the REAL helper as a native Python child against a private 0700
// fixture root bound to DISPATCH_STATE_DIR and AIGENTRY_REGISTRY_PROTOTYPE_ROOT. Instrumented cases import the real
// subject and WRAP (never replace) sqlite3.connect, the native lock call or os.lstat; there is no mock backend.
// Against the JSON-only baseline every "contract:" case fails with FEATURE ABSENT (the gap, not a broken harness);
// every "legacy control:" case must pass on baseline and candidate alike.
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
// Optional immutable subject input (same variable as the frozen transition suites); ordinary discovery needs none.
const registry = resolve(process.env.REGISTRY_TRANSITION_TEST_SCRIPT ?? join(repo, "bin/dispatch-registry.py"));
// The frozen pre-SQLite JSON helper that plays the "staged old registry.py" of 7.5: a byte-exact repository fixture
// (backward-compatibility evidence only, never shipped or enabled). An override must carry the same frozen identity.
const legacyRegistry = resolve(process.env.REGISTRY_SQLITE_LEGACY_SCRIPT ?? join(repo, "tests/fixtures/dispatch-registry-json-v2.py"));
const LEGACY_SHA256 = "b2faba137326691d2b1c04cb6be659533872491f7e15213bc41a0b4ad06c4583";
function frozenLegacy(): string {
  assert.equal(sha(readFileSync(legacyRegistry)), LEGACY_SHA256, `${legacyRegistry} is not the frozen pre-SQLite helper`);
  return legacyRegistry;
}
// Parent of the per-case mkdtemp roots; each root is forced to 0700 on POSIX.
const fixtureBase = resolve(process.env.REGISTRY_SQLITE_FIXTURE_BASE ?? tmpdir());
const windows = process.platform === "win32";
const darwin = process.platform === "darwin";
const expectedNewline = windows ? "\r\n" : "\n";
const essential: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" };
for (const key of ["SystemRoot", "WINDIR"]) {
  if (process.env[key]) essential[key] = process.env[key];
}
function pythonExecutable(): string {
  const choices = windows ? ["python"] : darwin ? ["/opt/homebrew/bin/python3", "python3"] : ["python3"];
  for (const command of choices) {
    const result = spawnSync(command, ["-I", "-B", "-c", "import sys; print(sys.executable)"],
      { env: essential, encoding: "utf8", timeout: 5000 });
    if (result.status === 0 && isAbsolute(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error("Python 3 executable is required for registry SQLite contract acceptance");
}
const python = pythonExecutable();

type Json = Record<string, unknown>;
type Run = SpawnSyncReturns<string>;

const IDENTITY = String.raw`
import json,os,sys
out=dict(executable=sys.executable,version=sys.version,platform=sys.platform,os_name=os.name)
try:
    import sqlite3
    con=sqlite3.connect(":memory:")
    out.update(sqlite_version=sqlite3.sqlite_version,sqlite_source_id=con.execute("select sqlite_source_id()").fetchone()[0],
               compile_options=[row[0] for row in con.execute("pragma compile_options")])
    con.close()
except Exception as exc:
    out.update(sqlite_error=repr(exc))
print(json.dumps(out))
`;
type Identity = { executable: string; version: string; platform: string; os_name: string; sqlite_version?: string;
  sqlite_source_id?: string; compile_options?: string[]; sqlite_error?: string };
function probeIdentity(): Identity {
  const result = spawnSync(python, ["-I", "-B", "-c", IDENTITY], { env: essential, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Identity;
}
const identity = probeIdentity();

// Test-owned oracle: reads COPIES of the store (SQLite may roll a copied hot journal back in the copy only), builds
// independent contract-exact fake stores, tampers fixtures and stages its own short-lived crashed writer.
const ORACLE = String.raw`
import json,os,pathlib,shutil,sqlite3,sys
META_DDL=("CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), storage_schema INTEGER NOT NULL CHECK(storage_schema=1), "
    "store_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1), mode TEXT NOT NULL CHECK(mode IN (%s)), transition TEXT)"
    % ",".join(chr(39)+m+chr(39) for m in ("MIGRATING","SQLITE","ROLLBACK_PREPARE","JSON")))
REGISTRY_DDL="CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)"
mode=sys.argv[1]
def compact(obj):
    return json.dumps(obj,separators=(",",":"))+"\n"
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
        documents=[r[0] if isinstance(r[0],str) else "BLOB:"+bytes(r[0]).hex() for r in con.execute("select document from registry")] if "registry" in tables else None,
        integrity=con.execute("pragma integrity_check").fetchone()[0]))
    con.close()
elif mode=="constraints":
    con=sqlite3.connect(copy_store(sys.argv[2],sys.argv[3]),isolation_level=None)
    probes=dict(meta_second_row=("insert into meta values(2,1,?,1,?,NULL)",("x","SQLITE")),
        meta_storage_schema_2=("update meta set storage_schema=2",()),
        meta_epoch_0=("update meta set epoch=0",()),
        meta_mode_unknown=("update meta set mode=?",("BOGUS",)),
        meta_store_id_null=("update meta set store_id=NULL",()),
        registry_second_row=("insert into registry values(2,?)",("{}",)),
        registry_document_null=("update registry set document=NULL",()))
    for m in ("MIGRATING","SQLITE","ROLLBACK_PREPARE","JSON"):
        probes["meta_mode_"+m]=("update meta set mode=?",(m,))
    result={}
    for name,(sql,params) in probes.items():
        con.execute("savepoint probe")
        try:
            con.execute(sql,params)
            result[name]="accepted"
        except sqlite3.IntegrityError:
            result[name]="rejected"
        con.execute("rollback to probe")
        con.execute("release probe")
    con.close()
    out(result)
elif mode=="build":
    state=sys.argv[2]
    o=json.loads(sys.argv[3])
    barrier=os.path.join(state,"active.json")
    os.mkdir(barrier,0o700)
    def put(name,data):
        fd=os.open(os.path.join(barrier,name),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        os.write(fd,data.encode())
        os.close(fd)
    sid=o["sid"]
    if o.get("pending"):
        put("init-pending",compact(dict(format=1,intent="init-store",store_id=sid)))
    put("authority.json",compact(dict(format=1,store_id=sid)))
    db=os.path.join(state,"active.db")
    kind=o.get("db","committed")
    if kind!="absent":
        os.close(os.open(db,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600))
    if kind not in ("absent","zero"):
        con=sqlite3.connect(db,isolation_level=None)
        con.execute("pragma journal_mode=truncate")
        if o.get("ignore_checks"):
            con.execute("pragma ignore_check_constraints=1")
        con.execute("begin")
        if kind=="foreign":
            con.execute("create table foreign_data(x)")
            con.execute("insert into foreign_data values(1)")
        else:
            con.execute(o.get("meta_ddl",META_DDL))
            con.execute("insert into meta(id,storage_schema,store_id,epoch,mode,transition) values(?,1,?,?,?,NULL)",
                (o.get("meta_id",1),o.get("meta_sid",sid),o.get("epoch",1),o.get("mode","SQLITE")))
            if kind!="only-meta":
                con.execute(o.get("registry_ddl",REGISTRY_DDL))
                text=json.dumps(o.get("document",dict(schema_version=2,generation=0,dispatches=[])))
                con.execute("insert into registry(id,document) values(?,?)",(o.get("registry_id",1),text.encode() if o.get("document_blob") else text))
            if o.get("extra_table"):
                con.execute("create table extra(x)")
            if o.get("extra_index"):
                con.execute("create index extra_idx on registry(document)")
            con.execute("pragma user_version=%d"%o.get("user_version",1))
        con.execute("commit")
        con.close()
    out(dict(built=kind))
elif mode=="schema":
    con=sqlite3.connect(copy_store(sys.argv[2],sys.argv[3]),isolation_level=None)
    objects=[list(r) for r in con.execute("select type,name,tbl_name,sql from sqlite_master order by type,name")]
    rows=[list(r) for r in con.execute("select id,typeof(document) from registry")] if any(o[1]=="registry" for o in objects) else None
    con.close()
    out(dict(objects=objects,registry_rows=rows))
elif mode=="mutate-many":
    con=sqlite3.connect(os.path.join(sys.argv[2],"active.db"),isolation_level=None)
    con.execute("pragma journal_mode=truncate")
    for sql,params in json.loads(sys.argv[3]):
        con.execute(sql,params)
    con.close()
    out(dict(mutated=True))
elif mode=="mutate":
    con=sqlite3.connect(os.path.join(sys.argv[2],"active.db"),isolation_level=None)
    con.execute("pragma journal_mode=truncate")
    con.execute(sys.argv[3],json.loads(sys.argv[4]))
    con.close()
    out(dict(mutated=True))
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
`;

// Instrumented caller: imports the real subject, wraps sqlite3.connect with a tracing factory (pragmas re-queried
// at close), optionally reports native lock contention and injects lstat errors for named entries, then runs main.
const HARNESS = String.raw`
import errno,importlib.util,json,os,sqlite3,sys,types
subject,argv_json,opts_json=sys.argv[1:4]
opts=json.loads(opts_json)
receipt=dict(connections=[],contended=0,lstat_faults=[])
live=[]
PRAGMAS=("journal_mode","synchronous","cache_spill","locking_mode","fullfsync")
def say(event,**fields):
    print("HARNESS "+json.dumps(dict(event=event,**fields)),file=sys.stderr,flush=True)
def final(con):
    if con.entry["final"] is None:
        con.set_trace_callback(None)
        try:
            con.entry["final"]={name:con.execute("pragma "+name).fetchone()[0] for name in PRAGMAS}
        except sqlite3.Error as exc:
            con.entry["final"]=dict(error=str(exc))
class Traced(sqlite3.Connection):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        target=args[0] if args else kwargs.get("database","")
        self.entry=dict(target=os.fsdecode(target) if isinstance(target,(str,bytes,os.PathLike)) else repr(target),
                        uri=bool(kwargs.get("uri")),statements=[],final=None)
        receipt["connections"].append(self.entry)
        live.append(self)
        self.set_trace_callback(self.entry["statements"].append)
    def close(self):
        final(self)
        super().close()
real_connect=sqlite3.connect
def traced_connect(*args,**kwargs):
    if "factory" in kwargs:
        receipt["foreign_factory"]=True
    kwargs["factory"]=Traced
    return real_connect(*args,**kwargs)
sqlite3.connect=traced_connect
spec=importlib.util.spec_from_file_location("registry_under_test",subject)
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
if opts.get("lock"):
    if os.name=="nt":
        import msvcrt as native
        real_lock=native.locking
        contended=(errno.EACCES,)
    else:
        import fcntl as native
        real_lock=native.flock
        contended=(errno.EAGAIN,errno.EACCES)
    def observed_lock(*args):
        try:
            return real_lock(*args)
        except OSError as exc:
            if exc.errno in contended:
                receipt["contended"]+=1
                if receipt["contended"]==1:
                    say("contended",pid=os.getpid())
            raise
    wrapped=types.SimpleNamespace(**{k:getattr(native,k) for k in dir(native) if not k.startswith("__")})
    setattr(wrapped,"locking" if os.name=="nt" else "flock",observed_lock)
    setattr(r,"msvcrt" if os.name=="nt" else "fcntl",wrapped)
names=set(opts.get("lstat_fault",[]))
if names:
    real_lstat=os.lstat
    def faulty_lstat(path,*args,**kwargs):
        name=os.path.basename(os.fsdecode(path)) if isinstance(path,(str,bytes,os.PathLike)) else ""
        if name in names:
            receipt["lstat_faults"].append(name)
            if opts.get("kind")=="eio":
                raise OSError(errno.EIO,"injected I/O error",path)
            raise PermissionError(errno.EACCES,"injected permission denied",path)
        return real_lstat(path,*args,**kwargs)
    os.lstat=faulty_lstat
try:
    rc=r.main(json.loads(argv_json))
finally:
    for con in live:
        try:
            final(con)
        except Exception:
            pass
    say("receipt",**receipt)
sys.exit(rc)
`;
const HOLDER = String.raw`
import json,os,sys
f=open(sys.argv[1],"a+b",buffering=0)
if os.name=="nt":
    import msvcrt
    f.seek(0,os.SEEK_SET)
    msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
else:
    import fcntl
    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
print(json.dumps(dict(acquired=True,pid=os.getpid())),flush=True)
sys.stdin.readline()
if os.name=="nt":
    f.seek(0,os.SEEK_SET)
    msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
else:
    fcntl.flock(f,fcntl.LOCK_UN)
f.close()
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
// Correction 7: exactly ONE advertised addition.
const CONTRACT_OPERATIONS = ["archive-sidecars", "begin-delivery", "check-dedup", "get", "init-store", "list", "migrate",
  "observe", "prune", "set-gate", "set-lifecycle", "set-transport-result", "snapshot"] as const;
type Op = typeof CONTRACT_OPERATIONS[number];
const ARTIFACTS = ["active.db", "active.db-journal", "active.db-wal", "active.db-shm",
  "active.json.source", "active.json.pre-sqlite.bak", "active.json.barrier.tmp"] as const;
// Diagnostic siblings a refusal may touch; neither is registry data or authority.
const DIAGNOSTIC: ReadonlySet<string> = new Set(["active.json.lock", "registry-health.log"]);
const STORE_LISTING = ["active.db", "active.db-journal", "active.json", "active.json.lock"];
const SUCCESS = new Set(["proceed", "store_initialized", "DISPATCH_DEDUPLICATED", "DISPATCH_RETRY_HELD", "migrated",
  "archived", "no_sidecars", "retry_held", "deduplicated"]);
const NOW = "2026-10-04T00:00:00Z";
const WINDOWS_WRITE_REFUSAL = "native Windows directory durability unavailable; registry write refused";
const EMPTY = { schema_version: 2, generation: 0, dispatches: [] };
// Native Windows refuses every non-json classification before any file (6.6); elsewhere the named token applies.
const nonJson = (token: string): string => windows ? "unsupported_platform" : token;

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function compact(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
// lstat-only walk: symlinks are recorded by target text and never followed.
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
function identifiesTransition(detail: unknown): boolean {
  return typeof detail === "string" && (/transition/i.test(detail) || ARTIFACTS.some(name => detail.includes(name)));
}
function oracle(mode: string, args: string[], status = 0): Json {
  const result = spawnSync(python, ["-I", "-B", "-c", ORACLE, mode, ...args], { env: essential, encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, status, `oracle ${mode}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as Json;
}

type Exit = { status: number | null; signal: NodeJS.Signals | null };
type Launched = { child: ChildProcessWithoutNullStreams; out: { stdout: string; stderr: string }; done: Promise<Exit>;
  until: (stream: "stdout" | "stderr", pattern: RegExp) => Promise<void> };
function spawnChild(pyArgs: string[], env: NodeJS.ProcessEnv, cwd: string): Launched {
  const child = spawn(python, ["-I", "-B", ...pyArgs], { cwd, env });
  const out = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { out.stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { out.stderr += chunk; });
  const done = new Promise<Exit>((settle, fail) => {
    child.on("error", fail);
    child.on("close", (status, signal) => settle({ status, signal }));
  });
  const until = (stream: "stdout" | "stderr", pattern: RegExp) => new Promise<void>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`timeout waiting for ${pattern} on ${stream}: ${JSON.stringify(out)}`)), 20000);
    const check = (): boolean => {
      if (!pattern.test(out[stream])) return false;
      clearTimeout(timer);
      settle();
      return true;
    };
    if (check()) return;
    child[stream].on("data", () => { check(); });
    done.then(() => {
      if (!check()) { clearTimeout(timer); fail(new Error(`exited before ${pattern} on ${stream}: ${JSON.stringify(out)}`)); }
    }, () => undefined);
  });
  return { child, out, done, until };
}

type Connection = { target: string; uri: boolean; statements: string[]; final: Json | null };
type Receipt = { connections: Connection[]; contended: number; lstat_faults: string[]; foreign_factory?: boolean };
type Semantic = { user_version: number; tables: string[]; meta: unknown[][] | null; documents: string[] | null; integrity: string };
function receiptOf(stderr: string): Receipt {
  const line = stderr.split("\n").reverse().find(text => text.startsWith("HARNESS ") && text.includes("\"event\": \"receipt\""));
  assert.ok(line, stderr);
  return JSON.parse(line.slice("HARNESS ".length)) as Receipt;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(fixtureBase, "registry-sqlite-"));
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
  const raw = (kind: string, args: string[], extra: NodeJS.ProcessEnv, result: Run) =>
    t.diagnostic(`RAW ${JSON.stringify({ kind, args, extra, status: result.status, stdout: result.stdout, stderr: result.stderr })}`);
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, script = registry): Run => {
    const result = spawnSync(python, ["-I", "-B", script, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    raw(script === registry ? "subject" : "script", args, extra, result);
    return result;
  };
  const instrumented = (argv: string[], opts: Json = {}, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(python, ["-I", "-B", "-c", HARNESS, registry, JSON.stringify(argv), JSON.stringify(opts)],
      { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    raw("instrumented", argv, extra, result);
    return { result, receipt: receiptOf(result.stderr) };
  };
  const launch = (pyArgs: string[], extra: NodeJS.ProcessEnv = {}) => spawnChild(pyArgs, { ...env, ...extra }, root);
  const hold = async () => {
    const holder = spawnChild(["-c", HOLDER, paths.L], essential, root);
    await holder.until("stdout", /"acquired": true/);
    return async () => {
      holder.child.stdin.end("\n");
      const exit = await holder.done;
      assert.equal(exit.status, 0, holder.out.stderr);
    };
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
  const generation = (): number => {
    const snapshot = run(["snapshot"]);
    assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
    return Number((JSON.parse(snapshot.stdout) as Json).generation);
  };
  const scratchDir = () => join(root, `oracle-${++scratch}`);
  return { root, state, env, paths, sidecars, run, instrumented, launch, hold, lockFree, semantic, doc, generation, scratchDir };
}
type Fixture = ReturnType<typeof fixture>;

function sidecarDir(f: Fixture) {
  mkdirSync(f.sidecars);
  writeFileSync(join(f.sidecars, "live-worker"), "hash-live\n");
  writeFileSync(join(f.sidecars, "claimed-done"), "hash-done\n");
}
function opArgs(f: Fixture, op: Op): string[] {
  switch (op) {
    case "archive-sidecars": return [op, "--dir", f.sidecars];
    case "begin-delivery": return [op, "--sid", "probe", "--ref-hash", "probe-hash", "--now", NOW];
    case "check-dedup": return [op, "--sid", "alpha", "--ref-hash", "h1"];
    case "get": return [op, "--sid", "alpha"];
    case "init-store": return [op];
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

// Desired refusal: exit 9, one JSON object, completion_fact null, no success result, optional token in result or
// detail, and the state tree (minus lock/health diagnostics) and any sidecar directory unchanged.
function refused(f: Fixture, args: string[], token?: string, extra: NodeJS.ProcessEnv = {}, script = registry): Json | null {
  const sidecars = () => present(f.sidecars) ? JSON.stringify(tree(f.sidecars)) : "absent";
  const before = tree(f.state, DIAGNOSTIC), sidecarsBefore = sidecars();
  const result = f.run(args, extra, script);
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
    "FEATURE ABSENT (baseline gap): the subject does not advertise init-store; this contract oracle needs a candidate");
}
function windowsInitRefused(f: Fixture): void {
  const before = tree(f.state);
  const result = f.run(["init-store"]);
  const payload = payloadOf(result.stdout);
  assert.equal(result.status, 9, result.stdout);
  assert.ok(names(payload, "unsupported_platform"), result.stdout);
  assert.equal(payload?.completion_fact, null);
  assert.deepEqual(changes(before, tree(f.state)), [], "native Windows init refusal touched the fixture");
  assert.equal(present(f.paths.H), false, "native Windows init refusal wrote a health log");
}
// Explicit prototype-gate init. On native Windows asserts the refusal instead and returns null (no SQLite proof).
function initStore(f: Fixture): { sid: string; payload: Json } | null {
  featureGap(f);
  if (windows) { windowsInitRefused(f); return null; }
  const payload = envelope(f.run(["init-store"]), 0, "store_initialized");
  const sid = String(payload.store_id);
  assert.match(sid, /^[0-9a-f]{32}$/);
  return { sid, payload };
}
// Steady-state store oracle after any successful operation (7.5 listing, A bytes, J size 0, meta row).
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
function beginAlpha(f: Fixture): void {
  envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 0, "proceed");
}

// --- parity transcript: every legacy operation, every exit class, generation after each step ----------------
function transcriptSteps(f: Fixture): string[][] {
  const n = ["--now", NOW], later = ["--now", "2030-01-01T00:00:00Z"];
  return [
    ["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", ...n],
    ["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", ...n],
    ["check-dedup", "--sid", "alpha", "--ref-hash", "h1"],
    ["set-transport-result", "--sid", "alpha", "--result", "write_observed", ...n],
    ["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", ...n],
    ["check-dedup", "--sid", "alpha", "--ref-hash", "h1"],
    ["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--ref-path", "refs/beta.md", "--cwd", "/work/beta", "--from",
      "orchestrator", "--track", "t1", "--role", "tester", "--branch", "b1", "--worktree", "/wt/beta", "--keep-alive", ...n],
    ["set-transport-result", "--sid", "beta", "--result", "unknown", "--inject-id", "inj-1", ...n],
    ["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--retry-unknown", "operator retry", ...n],
    ["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--retry-unknown", "not held", ...n],
    ["observe", "--sid", "beta", "--kind", "probe", "--field", "k=1", "--field", "s=text", "--json", "{\"a\":\"b\",\"terminal\":true}", ...n],
    ["observe", "--sid", "gamma", "--kind", "probe", ...n],
    ["set-lifecycle", "--sid", "alpha", "--state", "cleaned", ...n],
    ["observe", "--sid", "alpha", "--all", "--kind", "probe", ...n],
    ["set-lifecycle", "--sid", "beta", "--all", "--re-dispatch-count", "2", ...n],
    ["set-lifecycle", "--sid", "beta", "--all", "--state", "re_dispatched", "--extend-minutes", "15", ...n],
    ["set-lifecycle", "--sid", "beta", "--bump-re-dispatch-count", "--expected-report-by", "2026-10-05T00:00:00Z", ...n],
    ["set-gate", "--sid", "beta", "--state", "awaiting_user", ...n],
    ["set-gate", "--sid", "beta", ...n],
    ["set-gate", "--sid", "beta", "--clear", ...n],
    ["set-gate", "--sid", "gamma", "--state", "awaiting_user", ...n],
    ["set-transport-result", "--sid", "gamma", "--result", "unknown", ...n],
    ["set-transport-result", "--sid", "beta", "--result", "bogus", ...n],
    ["get", "--sid", "beta"],
    ["get", "--sid", "beta", "--pointer", "lifecycle.state"],
    ["get", "--sid", "beta", "--pointer", "observations"],
    ["get", "--sid", "gamma"],
    ["get", "--sid", "gamma", "--pointer", "lifecycle.state"],
    ["list", "--fields", "assigned.sid,lifecycle.state,gate.state,transport.result,re_dispatch_count"],
    ["list", "--live"],
    ["list", "--not-retired", "--fields", "assigned.sid,track,worktree"],
    ["list", "--keep-alive"],
    ["list", "--due-before", "2026-10-04T00:20:00Z", "--fields", "assigned.sid,expected_report_by"],
    ["snapshot"],
    ["prune", "--older-than-seconds", "0", ...later],
    ["prune", "--older-than-seconds", "0", ...later],
    ["snapshot"],
    ["archive-sidecars", "--dir", f.sidecars],
    ["archive-sidecars", "--dir", f.sidecars],
  ];
}
// Absolute oracle, verified on the JSON baseline: exits and generation after each step above.
const TRANSCRIPT_EXITS = [0, 7, 7, 0, 8, 8, 0, 0, 0, 4, 0, 9, 0, 0, 4, 0, 0, 0, 4, 0, 9, 9, 4,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const TRANSCRIPT_GENERATIONS = [1, 2, 2, 3, 4, 4, 5, 6, 7, 7, 8, 8, 9, 9, 9, 10, 11, 12, 12, 13, 13, 13, 13,
  13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 14, 15, 15, 15, 15];
type Entry = { args: string[]; status: number | null; stdout: string; stderr: string; generation: number };
function transcript(f: Fixture): Entry[] {
  sidecarDir(f);
  const ids = new Map<string, string>();
  const norm = (text: string) => text.split(f.sidecars).join("<SIDECARS>").split(f.root).join("<ROOT>")
    .replace(/\b[0-9a-f]{32}\b/g, id => {
      if (!ids.has(id)) ids.set(id, `<ID${ids.size}>`);
      return ids.get(id) ?? id;
    });
  return transcriptSteps(f).map(args => {
    const result = f.run(args);
    return { args: args.map(norm), status: result.status, stdout: norm(result.stdout), stderr: result.stderr, generation: f.generation() };
  });
}

async function concurrentBegin(f: Fixture, n: number) {
  const children = Array.from({ length: n }, () => f.launch([registry, "begin-delivery", "--sid", "race", "--ref-hash", "rh", "--now", NOW]));
  const exits = await Promise.all(children.map(child => child.done));
  return children.map((child, index) => ({ status: exits[index]?.status, signal: exits[index]?.signal, stdout: child.out.stdout, stderr: child.out.stderr }));
}
function assertRace(outcomes: Awaited<ReturnType<typeof concurrentBegin>>, doc: Json, base: number) {
  assert.deepEqual(outcomes.map(o => o.status).sort(), [0, 7, 7, 7, 7, 7, 7, 7], JSON.stringify(outcomes));
  assert.deepEqual(outcomes.filter(o => o.stderr !== "" || o.signal !== null), []);
  const results = outcomes.map(o => String(payloadOf(o.stdout)?.result)).sort();
  assert.deepEqual(results, ["DISPATCH_RETRY_HELD", "DISPATCH_RETRY_HELD", "DISPATCH_RETRY_HELD", "DISPATCH_RETRY_HELD",
    "DISPATCH_RETRY_HELD", "DISPATCH_RETRY_HELD", "DISPATCH_RETRY_HELD", "proceed"]);
  assert.equal(doc.generation, base + 8, "one generation per commit");
  const records = doc.dispatches as Json[];
  assert.equal(records.length, 1);
  const kinds = (records[0]?.observations as Json[]).map(o => o.kind).sort();
  assert.deepEqual(kinds, ["dedup_retry_held", "dedup_retry_held", "dedup_retry_held", "dedup_retry_held", "dedup_retry_held",
    "dedup_retry_held", "dedup_retry_held", "dispatch_tracking_started"]);
}

// Subject-side default state directory must never be touched by this suite (7.4).
const subjectState = join(dirname(dirname(registry)), "state", "dispatch");
const subjectStateBefore = present(subjectState) ? JSON.stringify(tree(subjectState)) : "absent";

test("receipt: subject identity, Python sqlite3 identity, private fixture root and legacy operation table", t => {
  t.diagnostic(`python ${JSON.stringify({ executable: identity.executable, version: identity.version, platform: identity.platform, os_name: identity.os_name })}`);
  t.diagnostic(`sqlite ${JSON.stringify({ sqlite_version: identity.sqlite_version, sqlite_source_id: identity.sqlite_source_id, sqlite_error: identity.sqlite_error })}`);
  t.diagnostic(`sqlite compile_options ${JSON.stringify(identity.compile_options ?? [])}`);
  t.diagnostic("G3 UNQUALIFIED: installed SQLite identity is recorded, not compared with the traced 3.49.1 source; filesystem type unmeasured");
  t.diagnostic(`node=${process.version}; fixtureBase=${fixtureBase}; repo=${repo}`);
  t.diagnostic(`registry=${registry}; sha256=${sha(readFileSync(registry))}`);
  t.diagnostic(`legacyRegistry=${legacyRegistry}; sha256=${sha(readFileSync(legacyRegistry))}`);
  t.diagnostic(windows ? "native Windows run" : "native POSIX run; Windows branches require native Windows CI");
  const f = fixture(t);
  if (!windows) assert.equal(lstatSync(f.root).mode & 0o777, 0o700, "fixture root is not private");
  const listed = f.run(["--list-ops"]);
  assert.equal(listed.status, 0, listed.stderr);
  const ops = listed.stdout.split(expectedNewline).filter(Boolean);
  assert.ok(listed.stdout.endsWith(expectedNewline));
  assert.deepEqual(ops.filter(op => op !== "init-store"), [...LEGACY_OPERATIONS], "the twelve legacy names changed");
  assert.ok(ops.length - LEGACY_OPERATIONS.length <= 1, `more than one addition: ${ops.join(",")}`);
});

test("feature probe: init-store availability on this subject (baseline gap evidence)", t => {
  const f = fixture(t);
  const advertised = f.run(["--list-ops"]).stdout.split(/\r?\n/).includes("init-store");
  const before = tree(f.state);
  const result = f.run(["init-store"]);
  if (!advertised) {
    t.diagnostic("FEATURE ABSENT: subject has no init-store; contract cases are planned failures until a candidate arrives");
    const payload = envelope(result, 4, "unknown_operation");
    assert.equal(payload.completion_fact, null);
    assert.deepEqual(changes(before, tree(f.state)), [], "unknown operation wrote state");
    return;
  }
  t.diagnostic("FEATURE PRESENT: subject advertises init-store");
  assert.notEqual(payloadOf(result.stdout)?.result, "unknown_operation");
});

test("legacy control: instrumented harness qualification (real subject imported, lstat fault observed, no SQLite on fresh)", t => {
  const f = fixture(t);
  const plain = f.instrumented(["snapshot"]);
  assert.equal(plain.result.status, 0, plain.result.stdout);
  assert.deepEqual(JSON.parse(plain.result.stdout), EMPTY);
  assert.deepEqual(plain.receipt.connections, [], "a fresh JSON read opened SQLite");
  for (const kind of ["eacces", "eio"]) {
    const before = tree(f.state, DIAGNOSTIC);
    const faulted = f.instrumented(["snapshot"], { lstat_fault: ["active.db"], kind });
    assert.equal(faulted.result.status, 9, faulted.result.stdout);
    assert.equal(payloadOf(faulted.result.stdout)?.completion_fact, null);
    assert.ok(faulted.receipt.lstat_faults.includes("active.db"), "fault seam never reached the artifact probe");
    assert.deepEqual(changes(before, tree(f.state, DIAGNOSTIC)), []);
  }
});

test("contract: --list-ops grows by exactly init-store (correction 7)", t => {
  const f = fixture(t);
  featureGap(f);
  const listed = f.run(["--list-ops"]);
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, CONTRACT_OPERATIONS.join(expectedNewline) + expectedNewline);
});

test("contract: init-store prototype gate needs explicit DISPATCH_STATE_DIR equal to the prototype root (C4, correction 1)", async t => {
  const gate = nonJson("capability_unqualified");
  await t.test("default state dir is never initialized", st => {
    const f = fixture(st);
    featureGap(f);
    const copy = join(f.root, "repo", "bin");
    mkdirSync(copy, { recursive: true });
    copyFileSync(registry, join(copy, "dispatch-registry.py"));
    const defaultState = join(f.root, "repo", "state", "dispatch");
    const result = f.run(["init-store"], { DISPATCH_STATE_DIR: undefined, AIGENTRY_REGISTRY_PROTOTYPE_ROOT: defaultState },
      join(copy, "dispatch-registry.py"));
    assert.equal(result.status, 9, result.stdout);
    assert.ok(names(payloadOf(result.stdout), gate), result.stdout);
    assert.equal(present(join(f.root, "repo", "state")), false, "default state dir was created");
  });
  for (const [label, extra] of [["prototype root unset", { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: undefined }],
    ["prototype root differs", { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: "OTHER" }]] as const) {
    await t.test(label, st => {
      const f = fixture(st);
      featureGap(f);
      const other = join(f.root, "other");
      mkdirSync(other);
      const env: NodeJS.ProcessEnv = extra.AIGENTRY_REGISTRY_PROTOTYPE_ROOT === "OTHER" ? { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: other } : { ...extra };
      const before = tree(f.state);
      const result = f.run(["init-store"], env);
      assert.equal(result.status, 9, result.stdout);
      assert.ok(names(payloadOf(result.stdout), gate), result.stdout);
      assert.equal(payloadOf(result.stdout)?.completion_fact, null);
      assert.deepEqual(changes(before, tree(f.state)), []);
    });
  }
  await t.test("init-store accepts no flags", st => {
    const f = fixture(st);
    featureGap(f);
    envelope(f.run(["init-store", "--bogus", "x"]), 4, "invalid_argument");
    assert.deepEqual(readdirSync(f.state), []);
  });
  await t.test("canonical equality admits a symlinked alias of the same root", st => {
    const f = fixture(st);
    featureGap(f);
    const alias = join(f.root, "alias");
    symlinkSync(f.state, alias, "dir");
    const result = f.run(["init-store"], { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: alias });
    if (windows) { assert.ok(names(payloadOf(result.stdout), "unsupported_platform"), result.stdout); return; }
    envelope(result, 0, "store_initialized");
  });
});

test("contract: init-store creates exactly the store listing, authority, schema and envelope (4.3-4.7)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  assert.deepEqual(store.payload, { result: "store_initialized", store_id: store.sid, generation: 0,
    sqlite_version: identity.sqlite_version, sqlite_source_id: identity.sqlite_source_id, completion_fact: null });
  assert.deepEqual(assertStore(f, store.sid), EMPTY);
  assert.equal(present(f.paths.H), false, "init wrote a health log");
  assert.equal(lstatSync(f.paths.L).size, 0);
  assert.equal(lstatSync(f.paths.B).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.paths.A).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.paths.D).mode & 0o777, 0o600);
  const header = readFileSync(f.paths.D).subarray(0, 100);
  assert.equal(header.subarray(0, 16).toString("latin1"), "SQLite format 3\0");
  assert.deepEqual([header[18], header[19]], [1, 1], "rollback-journal header expected (not WAL)");
  const rejected = oracle("constraints", [f.state, f.scratchDir()]);
  assert.deepEqual(rejected, { meta_second_row: "rejected", meta_storage_schema_2: "rejected", meta_epoch_0: "rejected",
    meta_mode_unknown: "rejected", meta_store_id_null: "rejected", registry_second_row: "rejected", registry_document_null: "rejected",
    meta_mode_MIGRATING: "accepted", meta_mode_SQLITE: "accepted", meta_mode_ROLLBACK_PREPARE: "accepted", meta_mode_JSON: "accepted" });
  const snapshot = f.run(["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stdout);
  assert.deepEqual(JSON.parse(snapshot.stdout), EMPTY);
  const before = tree(f.state);
  const again = f.run(["init-store"]);
  assert.equal(again.status, 9, again.stdout);
  assert.ok(names(payloadOf(again.stdout), "already_initialized"), again.stdout);
  assert.deepEqual(changes(before, tree(f.state, new Set(["registry-health.log"]))), []);
});

test("contract: init-store refuses json and artifact states without writing (4.2, 5.1)", async t => {
  await t.test("valid JSON registry requires the migration unit", st => {
    const f = fixture(st);
    featureGap(f);
    writeFileSync(f.paths.B, JSON.stringify({ ...EMPTY, generation: 12 }));
    refused(f, ["init-store"], windows ? "unsupported_platform" : "migration unit required");
    assert.equal(JSON.parse(readFileSync(f.paths.B, "utf8")).generation, 12);
  });
  for (const artifact of ARTIFACTS) {
    await t.test(`${artifact} without barrier keeps the existing guard`, st => {
      const f = fixture(st);
      featureGap(f);
      writeFileSync(join(f.state, artifact), `synthetic ${artifact} bytes\n`);
      const payload = refused(f, ["init-store"], windows ? "unsupported_platform" : undefined);
      if (!windows) assert.ok(identifiesTransition(payload?.detail), JSON.stringify(payload));
    });
  }
});

test("contract: writer pragmas, reader connections and URIs via the real helper (J2, J6, 5.2, 5.5)", t => {
  const f = fixture(t);
  featureGap(f);
  if (windows) { windowsInitRefused(f); return; }
  const check = (label: string, receipt: Receipt, writer: boolean) => {
    assert.equal(receipt.foreign_factory, undefined, `${label}: subject passed its own connection factory`);
    const store = receipt.connections.filter(c => c.target.includes("active.db"));
    const other = receipt.connections.filter(c => !c.target.includes("active.db"));
    assert.deepEqual(other.map(c => c.target).filter(target => target !== ":memory:"), [], `${label}: unexpected database targets`);
    assert.ok(store.length > 0, `${label}: no store connection`);
    for (const c of store) {
      assert.ok(c.uri && /^file:/.test(c.target) && /[?&]mode=(ro|rw)(&|$)/.test(c.target), `${label}: not a file URI with mode=ro|rw: ${c.target}`);
      assert.doesNotMatch(c.target, /mode=rwc/, `${label}: rwc is forbidden`);
    }
    const rw = store.filter(c => /[?&]mode=rw(&|$)/.test(c.target)), ro = store.filter(c => /[?&]mode=ro(&|$)/.test(c.target));
    for (const c of ro) {
      assert.deepEqual(c.statements.filter(s => /pragma\s+(\w+\.)?\w+\s*(=|\()/i.test(s)), [], `${label}: reader assigned a pragma`);
      assert.deepEqual(c.statements.filter(s => /^\s*(insert|update|delete|create|drop|alter|replace)\b|begin\s+(immediate|exclusive)/i.test(s)), [],
        `${label}: reader issued a write statement`);
    }
    if (!writer) { assert.deepEqual(rw.map(c => c.target), [], `${label}: reader opened mode=rw`); return []; }
    assert.ok(rw.length > 0, `${label}: writer opened no mode=rw connection`);
    for (const c of rw) {
      const final = c.final ?? {};
      assert.deepEqual({ journal_mode: final.journal_mode, synchronous: final.synchronous, cache_spill: final.cache_spill,
        locking_mode: final.locking_mode, ...(darwin ? { fullfsync: final.fullfsync } : {}) },
      { journal_mode: "truncate", synchronous: 3, cache_spill: 0, locking_mode: "normal", ...(darwin ? { fullfsync: 1 } : {}) },
      `${label}: writer pragmas ${JSON.stringify(c)}`);
    }
    return rw.flatMap(c => c.statements);
  };
  const init = f.instrumented(["init-store"]);
  envelope({ ...init.result, stderr: "" }, 0, "store_initialized");
  const initStatements = check("init-store", init.receipt, true);
  assert.ok(initStatements.some(s => /^\s*begin\s+exclusive/i.test(s)), "init-store did not BEGIN EXCLUSIVE");
  const begin = f.instrumented(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]);
  envelope({ ...begin.result, stderr: "" }, 0, "proceed");
  const beginStatements = check("begin-delivery", begin.receipt, true);
  assert.ok(beginStatements.some(s => /^\s*begin\s+immediate/i.test(s)), "writer did not BEGIN IMMEDIATE");
  for (const args of [["snapshot"], ["get", "--sid", "alpha"], ["list"], ["check-dedup", "--sid", "alpha", "--ref-hash", "h1"]]) {
    const read = f.instrumented(args);
    assert.ok(read.result.status === 0 || read.result.status === 7, read.result.stdout);
    check(args[0] ?? "", read.receipt, false);
  }
});

test("legacy control: JSON transcript keeps every exit, envelope and generation (6.4 baseline)", t => {
  const f = fixture(t);
  if (windows) {
    const payload = envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 9, "registry_write_failed");
    assert.equal(payload.detail, WINDOWS_WRITE_REFUSAL);
    return;
  }
  const entries = transcript(f);
  assert.deepEqual(entries.map(e => e.status), TRANSCRIPT_EXITS);
  assert.deepEqual(entries.map(e => e.generation), TRANSCRIPT_GENERATIONS);
  assert.deepEqual(entries.filter(e => e.stderr !== ""), []);
});

test("contract: SQLite transcript equals the JSON transcript byte for byte, incl TSV/get/snapshot (6.4, 7.5)", t => {
  const sqlite = fixture(t);
  const store = initStore(sqlite);
  if (!store) return;
  const json = fixture(t);
  const expected = transcript(json), actual = transcript(sqlite);
  assert.deepEqual(actual.map(e => e.status), TRANSCRIPT_EXITS);
  assert.deepEqual(actual, expected);
  const finalDoc = assertStore(sqlite, store.sid);
  assert.equal(finalDoc.generation, TRANSCRIPT_GENERATIONS[TRANSCRIPT_GENERATIONS.length - 1]);
  assert.deepEqual(finalDoc, JSON.parse(sqlite.run(["snapshot"]).stdout));
});

test("contract: reads create nothing and change no store bytes (5.5, 7.5)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  beginAlpha(f);
  envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 7, "DISPATCH_RETRY_HELD");
  const before = tree(f.state);
  for (const args of [["snapshot"], ["get", "--sid", "alpha"], ["get", "--sid", "alpha", "--pointer", "lifecycle.state"],
    ["get", "--sid", "absent"], ["list"], ["list", "--live", "--fields", "assigned.sid,transport.result"],
    ["check-dedup", "--sid", "alpha", "--ref-hash", "h1"], ["check-dedup", "--sid", "absent", "--ref-hash", "x"]]) {
    const result = f.run(args);
    assert.ok(result.status === 0 || result.status === 7, result.stdout + result.stderr);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(changes(before, tree(f.state)), [], "a read changed or created state");
  unlinkSync(f.paths.J);
  const withoutJournal = tree(f.state);
  assert.equal(f.run(["snapshot"]).status, 0);
  assert.deepEqual(changes(withoutJournal, tree(f.state)), [], "a reader created the journal");
});

test("legacy control: concurrent JSON begin-delivery N=8 yields one proceed and one generation per commit", async t => {
  const f = fixture(t);
  if (windows) return assert.equal(windowsBeginRefused(f), true);
  const outcomes = await concurrentBegin(f, 8);
  assertRace(outcomes, JSON.parse(readFileSync(f.paths.B, "utf8")) as Json, 0);
});
function windowsBeginRefused(f: Fixture): boolean {
  const payload = envelope(f.run(["begin-delivery", "--sid", "race", "--ref-hash", "rh"]), 9, "registry_write_failed");
  return payload.detail === WINDOWS_WRITE_REFUSAL;
}

test("contract: concurrent SQLite begin-delivery N=8 dedups under the lock (6.4, 7.5)", async t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  const outcomes = await concurrentBegin(f, 8);
  assertRace(outcomes, assertStore(f, store.sid), 0);
});

test("contract: an externally removed journal is recreated by the next writer (J4, J5, 7.5)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  beginAlpha(f);
  unlinkSync(f.paths.J);
  envelope(f.run(["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--now", NOW]), 0, "proceed");
  const doc = assertStore(f, store.sid);
  assert.equal(doc.generation, 2);
  assert.deepEqual((doc.dispatches as Json[]).map(r => (r.assigned as Json).sid), ["alpha", "beta"]);
});

test("contract: a missing store under valid authority is refused and never created (5.1, 5.5)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  unlinkSync(f.paths.D);
  unlinkSync(f.paths.J);
  for (const op of ["snapshot", "get", "list", "check-dedup", "begin-delivery", "observe", "prune"] as const) {
    refused(f, opArgs(f, op), "store_missing");
  }
  refused(f, ["init-store"]);
  assert.equal(present(f.paths.D), false, "active.db was created");
});

type Tamper = { name: string; token?: string; apply: (f: Fixture, sid: string) => void };
const OTHER_SID = "0123456789abcdef0123456789abcdef";
const TAMPERS: Tamper[] = [
  { name: "active.db-wal present", apply: f => writeFileSync(join(f.state, "active.db-wal"), "") },
  { name: "active.db-shm present", apply: f => writeFileSync(join(f.state, "active.db-shm"), "") },
  { name: "header bytes 18/19 are not 1", apply: f => {
    const bytes = readFileSync(f.paths.D);
    bytes[18] = 2; bytes[19] = 2;
    writeFileSync(f.paths.D, bytes);
  } },
  { name: "symlinked authority.json", apply: f => {
    renameSync(f.paths.A, join(f.root, "authority.real"));
    symlinkSync(join(f.root, "authority.real"), f.paths.A, "file");
  } },
  { name: "symlinked init-pending beside authority", apply: (f, sid) => {
    writeFileSync(join(f.root, "pending.real"), compact({ format: 1, intent: "init-store", store_id: sid }));
    symlinkSync(join(f.root, "pending.real"), f.paths.P, "file");
  } },
  { name: "symlinked active.db", apply: f => {
    renameSync(f.paths.D, join(f.root, "store.real"));
    symlinkSync(join(f.root, "store.real"), f.paths.D, "file");
  } },
  { name: "symlinked active.db-journal (dangling)", apply: f => {
    unlinkSync(f.paths.J);
    symlinkSync(join(f.root, "dangling", "journal"), f.paths.J, "file");
  } },
  { name: "authority store_id mismatch", apply: f => writeFileSync(f.paths.A, compact({ format: 1, store_id: OTHER_SID })) },
  { name: "authority not compact", apply: (f, sid) => writeFileSync(f.paths.A, `{"format": 1, "store_id": "${sid}"}\n`) },
  { name: "authority over 256 bytes", apply: (f, sid) => writeFileSync(f.paths.A, compact({ format: 1, store_id: sid, pad: "x".repeat(300) })) },
  { name: "authority uppercase store_id", apply: (f, sid) => writeFileSync(f.paths.A, compact({ format: 1, store_id: sid.toUpperCase() })) },
  { name: "authority format 2", apply: (f, sid) => writeFileSync(f.paths.A, compact({ format: 2, store_id: sid })) },
  { name: "unknown barrier entry", token: "barrier incomplete", apply: f => writeFileSync(join(f.paths.B, "unknown"), "x") },
  { name: "authority missing", token: "barrier incomplete", apply: f => unlinkSync(f.paths.A) },
  { name: "meta store_id mismatch", apply: () => undefined },
  { name: "meta epoch 2", apply: () => undefined },
  { name: "meta mode JSON", apply: () => undefined },
  { name: "extra table", apply: () => undefined },
  { name: "user_version 2", apply: () => undefined },
  { name: "document schema_version 1", apply: () => undefined },
];
const SQL_TAMPER: Record<string, [string, unknown[]]> = {
  "meta store_id mismatch": ["update meta set store_id=?", [OTHER_SID]],
  "meta epoch 2": ["update meta set epoch=2", []],
  "meta mode JSON": ["update meta set mode=?", ["JSON"]],
  "extra table": ["create table extra(x)", []],
  "user_version 2": ["pragma user_version=2", []],
  "document schema_version 1": ["update registry set document=?", [JSON.stringify({ schema_version: 1, generation: 1, dispatches: [] })]],
};

test("contract: refusals keep the listing identical for every tampered store (5.1-5.4, 7.5)", async t => {
  for (const tamper of TAMPERS) {
    await t.test(tamper.name, st => {
      const f = fixture(st);
      const store = initStore(f);
      if (!store) return;
      beginAlpha(f);
      const sql = SQL_TAMPER[tamper.name];
      if (sql) oracle("mutate", [f.state, sql[0], JSON.stringify(sql[1])]);
      tamper.apply(f, store.sid);
      const realStore = present(join(f.root, "store.real")) ? sha(readFileSync(join(f.root, "store.real"))) : null;
      for (const op of ["snapshot", "get", "check-dedup", "begin-delivery", "observe", "set-gate", "prune", "init-store"] as const) {
        refused(f, opArgs(f, op), tamper.token);
      }
      if (realStore) assert.equal(sha(readFileSync(join(f.root, "store.real"))), realStore, "symlink target changed");
      assert.equal(present(join(f.root, "dangling")), false, "dangling symlink target was created");
    });
  }
});

type Built = { name: string; build: (f: Fixture) => void; token?: string; resume?: boolean };
const SID = "fedcba9876543210fedcba9876543210";
const build = (f: Fixture, options: Json) => { oracle("build", [f.state, JSON.stringify({ sid: SID, ...options })]); };
const BUILT: Built[] = [
  { name: "barrier empty", token: "barrier incomplete", build: f => mkdirSync(f.paths.B, { mode: 0o700 }) },
  { name: "barrier with pending only", token: "barrier incomplete", build: f => {
    mkdirSync(f.paths.B, { mode: 0o700 });
    writeFileSync(f.paths.P, compact({ format: 1, intent: "init-store", store_id: SID }), { mode: 0o600 });
  } },
  { name: "pending and authority sid differ", build: f => {
    build(f, { db: "absent" });
    writeFileSync(f.paths.P, compact({ format: 1, intent: "init-store", store_id: OTHER_SID }));
  } },
  { name: "authority without store", token: "store_missing", build: f => build(f, { db: "absent" }) },
  { name: "pending with foreign nonzero store", build: f => build(f, { pending: true, db: "foreign" }) },
  { name: "pending committed with other store_id", build: f => build(f, { pending: true, meta_sid: OTHER_SID }) },
  { name: "pending committed with epoch 2", build: f => build(f, { pending: true, epoch: 2 }) },
  { name: "pending committed with mode JSON", build: f => build(f, { pending: true, mode: "JSON" }) },
  { name: "pending committed with generation 5", build: f => build(f, { pending: true, document: { ...EMPTY, generation: 5 } }) },
  { name: "pending committed with a dispatch", build: f => build(f, { pending: true, document: { ...EMPTY, dispatches: [record()] } }) },
  { name: "pending partial schema (meta only)", build: f => build(f, { pending: true, db: "only-meta" }) },
  { name: "pending committed with extra table", build: f => build(f, { pending: true, extra_table: true }) },
  { name: "pending committed with user_version 2", build: f => build(f, { pending: true, user_version: 2 }) },
  { name: "pending exact committed generation 0", resume: true, build: f => build(f, { pending: true }) },
  { name: "pending zero-byte owned store", resume: true, build: f => build(f, { pending: true, db: "zero" }) },
  { name: "pending before store creation", resume: true, build: f => build(f, { pending: true, db: "absent" }) },
];
function record() {
  return {
    dispatch_id: "independent-fixture", assigned: { sid: "alpha", session_epoch: null },
    dedup: { key: createHash("sha256").update("alpha\0h1").digest("hex"), ref_hash: "h1" },
    outcome: { state: "unknown", reported_value: null, basis: null },
    lifecycle: { state: "delivery_attempt_started", at: "2026-05-12T11:00:00Z" }, transport: { result: "unknown", inject_id: null, at: null },
    gate: { state: null, prev_lifecycle: null }, observations: [], last_observation: null,
    last_seen_at: "2026-05-12T11:00:00Z", re_dispatch_count: 0, keep_alive: false,
  };
}

test("contract: independently built barrier, pending and resume states (B4, 4.6, correction 3)", async t => {
  for (const state of BUILT) {
    await t.test(state.name, st => {
      const f = fixture(st);
      featureGap(f);
      sidecarDir(f);
      state.build(f);
      for (const op of LEGACY_OPERATIONS) refused(f, opArgs(f, op), state.token === undefined ? (windows ? "unsupported_platform" : undefined) : nonJson(state.token));
      if (!state.resume || windows) {
        refused(f, ["init-store"], state.token === undefined ? (windows ? "unsupported_platform" : undefined) : nonJson(state.token));
        return;
      }
      const authority = readFileSync(f.paths.A);
      const payload = envelope(f.run(["init-store"]), 0, "store_initialized");
      assert.equal(payload.store_id, SID, "resume must keep the pending store_id");
      assert.deepEqual(readFileSync(f.paths.A), authority);
      assert.deepEqual(assertStore(f, SID), EMPTY);
      envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 0, "proceed");
      assert.equal(assertStore(f, SID).generation, 1);
    });
  }
});

test("contract: an independently built contract-exact store is served by every operation (5.2, 5.3)", t => {
  const f = fixture(t);
  featureGap(f);
  const document = { schema_version: 2, generation: 41, dispatches: [record()] };
  build(f, { document });
  if (windows) { refused(f, ["snapshot"], "unsupported_platform"); return; }
  const snapshot = f.run(["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stdout);
  assert.equal(snapshot.stdout, JSON.stringify(document, null, 2) + "\n");
  assert.equal(f.run(["get", "--sid", "alpha", "--pointer", "lifecycle.state"]).stdout, "delivery_attempt_started\n");
  envelope(f.run(["check-dedup", "--sid", "alpha", "--ref-hash", "h1"]), 7, "retry_held");
  envelope(f.run(["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--now", NOW]), 0, "proceed");
  const doc = assertStore(f, SID);
  assert.equal(doc.generation, 42);
});

// --- decision r2.1: only the canonical STORE_DDL and registry row id 1 are adopted --------------------------
// Contract 4.5 spelling. SQLite normalizes only the leading CREATE TABLE keywords in sqlite_master, so foreign
// spellings below vary text inside the column list.
const Q = String.fromCharCode(39);
const MODES = ["MIGRATING", "SQLITE", "ROLLBACK_PREPARE", "JSON"].map(m => Q + m + Q).join(",");
const CANONICAL_META = "CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1), storage_schema INTEGER NOT NULL CHECK(storage_schema=1), " +
  `store_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1), mode TEXT NOT NULL CHECK(mode IN (${MODES})), transition TEXT)`;
const CANONICAL_REGISTRY = "CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)";
const CANONICAL_OBJECTS = [["table", "meta", "meta", CANONICAL_META], ["table", "registry", "registry", CANONICAL_REGISTRY]];
const REGISTRY_NO_CHECK = CANONICAL_REGISTRY.replace(" CHECK(id=1)", "");
const NONCANONICAL: { name: string; options: Json }[] = [
  { name: "registry row id 2 (CHECK bypassed in fixture)", options: { registry_id: 2, ignore_checks: true } },
  { name: "registry without CHECK(id=1), row id 2", options: { registry_ddl: REGISTRY_NO_CHECK, registry_id: 2 } },
  { name: "registry without CHECK(id=1), row id 1", options: { registry_ddl: REGISTRY_NO_CHECK } },
  { name: "same table names, no constraints", options: { meta_ddl: "CREATE TABLE meta(id, storage_schema, store_id, epoch, mode, transition)",
    registry_ddl: "CREATE TABLE registry(id, document)" } },
  { name: "registry with an extra column", options: { registry_ddl: CANONICAL_REGISTRY.replace("document TEXT NOT NULL)", "document TEXT NOT NULL, extra TEXT)") } },
  { name: "meta with an extra column", options: { meta_ddl: CANONICAL_META.replace("transition TEXT)", "transition TEXT, extra TEXT)") } },
  { name: "meta mode without its CHECK", options: { meta_ddl: CANONICAL_META.replace(` CHECK(mode IN (${MODES}))`, "") } },
  { name: "equivalent spelling: lowercase column type", options: { registry_ddl: CANONICAL_REGISTRY.replace("document TEXT", "document text") } },
  { name: "equivalent spelling: extra whitespace", options: { registry_ddl: CANONICAL_REGISTRY.replace("document TEXT", "document  TEXT") } },
  { name: "registry document stored as BLOB", options: { document_blob: true } },
  { name: "extra index object", options: { extra_index: true } },
];
function schemaOf(f: Fixture): Json {
  return oracle("schema", [f.state, f.scratchDir()]);
}
// Store refusal: exit 9, one JSON object, completion_fact null, no success; barrier bytes (A and any P), D bytes,
// schema objects, rows and documents unchanged. The journal is excluded (a rolled-back writer may touch it, J5).
function refusedStore(f: Fixture, args: string[], token?: string): void {
  const skip = new Set([...DIAGNOSTIC, "active.db-journal"]);
  const before = { tree: tree(f.state, skip), schema: schemaOf(f), view: f.semantic() };
  const result = f.run(args);
  const payload = payloadOf(result.stdout);
  const observed = {
    status: result.status, stderr: result.stderr, one_object: payload !== null,
    completion_fact: payload && "completion_fact" in payload ? payload.completion_fact : "missing",
    success: SUCCESS.has(String(payload?.result)), names_token: token === undefined || names(payload, token),
    changes: changes(before.tree, tree(f.state, skip)),
    schema_kept: JSON.stringify(schemaOf(f)) === JSON.stringify(before.schema),
    content_kept: JSON.stringify(f.semantic()) === JSON.stringify(before.view),
  };
  assert.deepEqual(observed, { status: 9, stderr: "", one_object: true, completion_fact: null, success: false, names_token: true,
    changes: [], schema_kept: true, content_kept: true }, `${args.join(" ")}: ${result.stdout}`);
}
const STORE_OPS = ["snapshot", "get", "list", "check-dedup", "begin-delivery", "observe", "set-gate", "prune"] as const;

test("contract: fixture canonical DDL equals the DDL the subject init-store writes (precondition for decision r2.1)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  assert.deepEqual(schemaOf(f), { objects: CANONICAL_OBJECTS, registry_rows: [[1, "text"]] }, "subject DDL differs from contract 4.5 spelling");
  const g = fixture(t);
  build(g, {});
  assert.deepEqual(schemaOf(g), { objects: CANONICAL_OBJECTS, registry_rows: [[1, "text"]] }, "fixture builder DDL differs from contract 4.5 spelling");
});

test("contract: non-canonical stored schema or registry row id is refused by normal reads and writes (decision r2.1)", async t => {
  await t.test("control: canonical DDL and row ids 1 are served", st => {
    const f = fixture(st);
    featureGap(f);
    build(f, {});
    if (windows) { refused(f, ["snapshot"], "unsupported_platform"); return; }
    assert.deepEqual(JSON.parse(f.run(["snapshot"]).stdout), EMPTY);
    envelope(f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]), 0, "proceed");
    assert.equal(assertStore(f, SID).generation, 1);
  });
  await t.test("control: subject-created store is served", st => {
    const f = fixture(st);
    const store = initStore(f);
    if (!store) return;
    beginAlpha(f);
    assert.equal(assertStore(f, store.sid).generation, 1);
  });
  for (const variant of NONCANONICAL) {
    await t.test(variant.name, st => {
      const f = fixture(st);
      featureGap(f);
      build(f, variant.options);
      if (windows) { refused(f, ["snapshot"], "unsupported_platform"); return; }
      for (const op of STORE_OPS) refusedStore(f, opArgs(f, op));
    });
  }
  await t.test("subject-created store with the registry row id rewritten to 2", st => {
    const f = fixture(st);
    const store = initStore(f);
    if (!store) return;
    beginAlpha(f);
    oracle("mutate-many", [f.state, JSON.stringify([["pragma ignore_check_constraints=1", []], ["update registry set id=2", []]])]);
    for (const op of STORE_OPS) refusedStore(f, opArgs(f, op));
  });
});

test("contract: committed init resume refuses non-canonical schema or registry row id and keeps the pending marker (decision r2.1, correction 3)", async t => {
  await t.test("control: canonical committed generation 0 resumes", st => {
    const f = fixture(st);
    featureGap(f);
    build(f, { pending: true });
    if (windows) { refused(f, ["init-store"], "unsupported_platform"); return; }
    assert.equal(envelope(f.run(["init-store"]), 0, "store_initialized").store_id, SID);
    assert.deepEqual(assertStore(f, SID), EMPTY);
  });
  for (const variant of NONCANONICAL) {
    await t.test(variant.name, st => {
      const f = fixture(st);
      featureGap(f);
      build(f, { ...variant.options, pending: true });
      if (windows) { refused(f, ["init-store"], "unsupported_platform"); return; }
      const pending = readFileSync(f.paths.P);
      refusedStore(f, ["init-store"]);
      assert.deepEqual(readFileSync(f.paths.P), pending, "pending marker changed");
      assert.deepEqual(readdirSync(f.paths.B).sort(), ["authority.json", "init-pending"]);
      for (const op of ["snapshot", "begin-delivery"] as const) refusedStore(f, opArgs(f, op));
    });
  }
});

// --- decision r2.2: advisory classification precedes the prototype gate for advertised init-store ---------
test("contract: init-store keeps the seven-artifact refusal before the prototype gate (decision r2.2)", async t => {
  for (const artifact of ARTIFACTS) {
    for (const bound of [false, true]) {
      await t.test(`${artifact}, prototype root ${bound ? "bound" : "unbound"}`, st => {
        const f = fixture(st);
        featureGap(f);
        writeFileSync(join(f.state, artifact), `synthetic ${artifact} bytes\n`);
        if (windows) { windowsInitRefused(f); return; }
        const skip: ReadonlySet<string> = bound ? DIAGNOSTIC : new Set(["registry-health.log"]);
        const before = tree(f.state, skip);
        const result = f.run(["init-store"], bound ? {} : { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: undefined });
        const payload = envelope(result, 9, "registry_unavailable");
        assert.ok(identifiesTransition(payload.detail), result.stdout);
        assert.equal(payload.completion_fact, null);
        assert.deepEqual(changes(before, tree(f.state, skip)), [], bound ? "refusal changed state" : "unbound refusal created the lock or state");
      });
    }
  }
  await t.test("fresh state unbound stays capability_unqualified and creates nothing", st => {
    const f = fixture(st);
    featureGap(f);
    const result = f.run(["init-store"], { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: undefined });
    assert.equal(result.status, 9, result.stdout);
    assert.ok(names(payloadOf(result.stdout), nonJson("capability_unqualified")), result.stdout);
    assert.deepEqual(readdirSync(f.state), []);
  });
  await t.test("partial barrier unbound refuses without creating the lock", st => {
    const f = fixture(st);
    featureGap(f);
    mkdirSync(f.paths.B, { mode: 0o700 });
    const before = tree(f.state, new Set(["registry-health.log"]));
    const result = f.run(["init-store"], { AIGENTRY_REGISTRY_PROTOTYPE_ROOT: undefined });
    assert.equal(result.status, 9, result.stdout);
    assert.equal(payloadOf(result.stdout)?.completion_fact, null);
    assert.deepEqual(changes(before, tree(f.state, new Set(["registry-health.log"]))), []);
  });
});

test("legacy control: a symlinked active.json keeps the current JSON outcome (5.4)", t => {
  const f = fixture(t);
  const target = join(f.root, "elsewhere.json");
  const original = JSON.stringify({ ...EMPTY, generation: 12 });
  writeFileSync(target, original);
  symlinkSync(target, f.paths.B, "file");
  const snapshot = f.run(["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
  assert.equal(JSON.parse(snapshot.stdout).generation, 12);
  const begin = f.run(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]);
  if (windows) {
    assert.equal(envelope(begin, 9, "registry_write_failed").detail, WINDOWS_WRITE_REFUSAL);
  } else {
    envelope(begin, 0, "proceed");
    assert.ok(lstatSync(f.paths.B).isFile(), "atomic rename replaces the link with a regular file today");
    assert.equal(JSON.parse(readFileSync(f.paths.B, "utf8")).generation, 13);
  }
  assert.equal(readFileSync(target, "utf8"), original, "link target was written");
});

test("legacy control: compatible JSON code facing the barrier directory publishes nothing (B1)", t => {
  const f = fixture(t);
  mkdirSync(f.paths.B, { mode: 0o700 });
  for (const args of [["snapshot"], ["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW], ["migrate", "--now", NOW]]) {
    refused(f, args, undefined, {}, frozenLegacy());
  }
  assert.ok(lstatSync(f.paths.B).isDirectory());
  assert.deepEqual(readdirSync(f.paths.B), []);
  assert.deepEqual(readdirSync(f.state).filter(name => name.endsWith(".tmp")), []);
});

test("contract: the staged old registry.py refuses every operation against an initialized store (7.5)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  beginAlpha(f);
  const legacyOps = f.run(["--list-ops"], {}, frozenLegacy()).stdout.split(/\r?\n/);
  assert.equal(legacyOps.includes("init-store"), false, "the frozen pre-SQLite helper advertises init-store");
  sidecarDir(f);
  for (const op of LEGACY_OPERATIONS) {
    const payload = refused(f, opArgs(f, op), undefined, {}, frozenLegacy());
    assert.ok(identifiesTransition(payload?.detail), JSON.stringify(payload));
  }
  assert.equal(assertStore(f, store.sid).generation, 1);
});

test("contract: migrate keeps the default _Lock artifact guard; archive-sidecars still works on a store (6.1, 6.4)", t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  const payload = refused(f, ["migrate", "--now", NOW]);
  assert.ok(identifiesTransition(payload?.detail), JSON.stringify(payload));
  assert.equal(present(join(f.state, "active.json.legacy-v1.bak")), false);
  sidecarDir(f);
  envelope(f.run(["archive-sidecars", "--dir", f.sidecars]), 0, "archived");
  assert.equal(readFileSync(join(`${f.sidecars}.archived`, "live-worker"), "utf8"), "hash-live\n");
  assertStore(f, store.sid);
});

test("legacy control: a waiting JSON writer re-reads the registry under the stable lock", async t => {
  const f = fixture(t);
  const release = await f.hold();
  const writer = f.launch(["-c", HARNESS, registry, JSON.stringify(["begin-delivery", "--sid", "alpha", "--ref-hash", "h1", "--now", NOW]),
    JSON.stringify({ lock: true })]);
  await writer.until("stderr", /"event": "contended"/);
  writeFileSync(f.paths.B, JSON.stringify({ ...EMPTY, generation: 12 }));
  await release();
  const exit = await writer.done;
  if (windows) {
    assert.equal(exit.status, 9, writer.out.stdout);
    assert.equal(payloadOf(writer.out.stdout)?.detail, WINDOWS_WRITE_REFUSAL);
    return;
  }
  assert.equal(exit.status, 0, writer.out.stdout + writer.out.stderr);
  assert.equal(JSON.parse(readFileSync(f.paths.B, "utf8")).generation, 13);
});

test("contract: a waiting writer reclassifies under the lock (6.2, correction 4)", async t => {
  await t.test("fresh becomes an initialized store while waiting", async st => {
    const donor = fixture(st);
    const store = initStore(donor);
    if (!store) return;
    const f = fixture(st);
    const release = await f.hold();
    const writer = f.launch(["-c", HARNESS, registry, JSON.stringify(["begin-delivery", "--sid", "reclassified", "--ref-hash", "h", "--now", NOW]),
      JSON.stringify({ lock: true })]);
    await writer.until("stderr", /"event": "contended"/);
    for (const name of ["active.json", "active.db", "active.db-journal"]) renameSync(join(donor.state, name), join(f.state, name));
    await release();
    const exit = await writer.done;
    assert.equal(exit.status, 0, writer.out.stdout + writer.out.stderr);
    assert.equal(payloadOf(writer.out.stdout)?.result, "proceed");
    const doc = assertStore(f, store.sid);
    assert.equal(doc.generation, 1);
    assert.deepEqual((doc.dispatches as Json[]).map(r => (r.assigned as Json).sid), ["reclassified"]);
  });
  await t.test("fresh becomes a partial barrier while waiting", async st => {
    const f = fixture(st);
    featureGap(f);
    const release = await f.hold();
    const writer = f.launch(["-c", HARNESS, registry, JSON.stringify(["begin-delivery", "--sid", "a", "--ref-hash", "h", "--now", NOW]),
      JSON.stringify({ lock: true })]);
    await writer.until("stderr", /"event": "contended"/);
    mkdirSync(f.paths.B, { mode: 0o700 });
    await release();
    const exit = await writer.done;
    assert.equal(exit.status, 9, writer.out.stdout);
    assert.ok(names(payloadOf(writer.out.stdout), nonJson("barrier incomplete")), writer.out.stdout);
    assert.ok(lstatSync(f.paths.B).isDirectory());
    assert.deepEqual(readdirSync(f.paths.B), []);
  });
});

test("contract: stable lock inode, unlock on error and lock timeout (6.5, correction 4)", async t => {
  const f = fixture(t);
  const store = initStore(f);
  if (!store) return;
  const inode = lstatSync(f.paths.L).ino;
  beginAlpha(f);
  assert.equal(f.run(["observe", "--sid", "alpha", "--kind", "probe", "--now", NOW]).status, 0);
  assert.equal(lstatSync(f.paths.L).ino, inode, "lock file was replaced");
  const failed = f.run(["observe", "--sid", "alpha", "--kind", "probe", "--now", NOW], { AIGENTRY_REGISTRY_FAULT: "w_dirsync_fail" });
  assert.equal(failed.status, 9, failed.stdout);
  assert.equal(f.lockFree(), true, "lock still held after a failed write");
  const release = await f.hold();
  try {
    const generation = f.doc().generation;
    const timedOut = f.run(["observe", "--sid", "alpha", "--kind", "probe", "--now", NOW]);
    assert.equal(timedOut.status, 9, timedOut.stdout);
    assert.ok(names(payloadOf(timedOut.stdout), "lock timeout"), timedOut.stdout);
    assert.equal(f.doc().generation, generation);
  } finally {
    await release();
  }
  assert.equal(lstatSync(f.paths.L).ino, inode);
});

test("contract: lstat errors on barrier entries refuse without writing (5.1)", async t => {
  for (const name of ["active.json", "authority.json", "active.db", "active.db-journal"]) {
    for (const kind of ["eacces", "eio"]) {
      await t.test(`${name} ${kind}`, st => {
        const f = fixture(st);
        const store = initStore(f);
        if (!store) return;
        beginAlpha(f);
        for (const args of [["snapshot"], ["begin-delivery", "--sid", "beta", "--ref-hash", "h2", "--now", NOW]]) {
          const before = tree(f.state, DIAGNOSTIC);
          const { result, receipt } = f.instrumented(args, { lstat_fault: [name], kind });
          assert.equal(result.status, 9, result.stdout);
          assert.equal(payloadOf(result.stdout)?.completion_fact, null);
          assert.ok(receipt.lstat_faults.includes(name), `${name} was never lstat-probed`);
          assert.deepEqual(changes(before, tree(f.state, DIAGNOSTIC)), []);
        }
      });
    }
  }
});

test("native Windows: new init refused, fresh and JSON reads retained (6.6, correction 2)", t => {
  const fresh = fixture(t);
  const snapshot = fresh.run(["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout), EMPTY);
  envelope(fresh.run(["check-dedup", "--sid", "a", "--ref-hash", "h"]), 0, "proceed");
  const json = fixture(t);
  writeFileSync(json.paths.B, JSON.stringify({ ...EMPTY, generation: 12 }));
  assert.equal(JSON.parse(json.run(["snapshot"]).stdout).generation, 12);
  if (windows) {
    featureGap(fresh);
    windowsInitRefused(fresh);
    assert.equal(windowsBeginRefused(fresh), true);
    assert.deepEqual(readdirSync(fresh.state).filter(name => name !== "active.json.lock"), []);
    return;
  }
  assert.notEqual(payloadOf(fresh.run(["init-store"]).stdout)?.result, "unsupported_platform");
});

test("receipt: the subject repository state/dispatch was not touched", () => {
  assert.equal(present(subjectState) ? JSON.stringify(tree(subjectState)) : "absent", subjectStateBefore);
});
