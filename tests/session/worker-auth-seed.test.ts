// Seed-validation coverage for src/session/worker-sandbox.ts `seedAuth`.
//
// The candidate functions are taken from the TypeScript source by AST node
// position (ts.createSourceFile -> FunctionDeclaration -> getStart/getEnd), then
// type-erased with ts.transpileModule and evaluated in a node:vm context whose
// only bindings are the explicit fakes below. Nothing here imports the module,
// the sandbox runner, the real homedir, a real credential store, the Keychain or
// any Claude process: `execFileSync` is a fake that records argv and never
// spawns. Every credential string is fabricated.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { inspect } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// `typescript` is already the compiler for this repo's build; used here as a
// library only (parse + type erasure), not as a new dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require("typescript");

// `scripts/run-tests.mjs` collects `dist/tests/**/*.test.js`, so this file runs
// as `dist/tests/session/worker-auth-seed.test.js` and the repo root is exactly
// three levels up. The layout is pinned rather than searched: an ancestor walk
// could silently bind to some *other* checkout's `src/session/worker-sandbox.ts`
// and report a green run against source this repo never compiled.
const COMPILED_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_TAIL = path.join("dist", "tests", "session");
if (!COMPILED_DIR.endsWith(path.sep + EXPECTED_TAIL)) {
  throw new Error(`expected the compiled test under ${EXPECTED_TAIL}, ran from ${COMPILED_DIR}`);
}
const REPO_ROOT = path.resolve(COMPILED_DIR, "..", "..", "..");
const SOURCE_FILE = path.join(REPO_ROOT, "src", "session", "worker-sandbox.ts");
if (!fs.existsSync(SOURCE_FILE)) throw new Error(`candidate source not found: ${SOURCE_FILE}`);
const WHOLE = fs.readFileSync(SOURCE_FILE, "utf8");

/** Exact declaration bytes for the named top-level functions, by AST position. */
function extract(names: string[]): Map<string, string> {
  const sf = ts.createSourceFile(SOURCE_FILE, WHOLE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics?.length) throw new Error(`PARSE_DIAGNOSTICS: ${sf.parseDiagnostics.length}`);
  const found = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) {
      found.set(st.name.text, WHOLE.slice(st.getStart(sf), st.getEnd()));
    }
  }
  for (const n of names) if (!found.has(n)) throw new Error(`DECL_NOT_FOUND: ${n}`);
  return found;
}

const DECLS = extract(["writePrivate", "seedAuth"]);
const ERASED = ts.transpileModule(
  `${DECLS.get("writePrivate")}\n${DECLS.get("seedAuth")}\n`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true } },
).outputText;
const PROGRAM = `${ERASED}\n;({ seedAuth, writePrivate });`;
// `writePrivate` carries the `export` modifier in the source, so transpileModule emits the
// CommonJS form (`exports.writePrivate = writePrivate`). The declaration bytes stay exact;
// each evaluation instead gets its own context-owned `exports` object to receive that
// assignment, and the tests below pin what lands there.
const EXPECTED_EXPORTS = ["writePrivate"];

interface Decls {
  seedAuth: (cli: string, home: string, cwd: string, oauthSelected?: boolean) => Record<string, string>;
  writePrivate: (file: string, data: string) => void;
}

/** Evaluates PROGRAM in a fresh context holding only `globals` plus its own `exports` sink. */
function load(globals: Record<string, unknown>): Decls & { exports: Record<string, unknown> } {
  const sink: Record<string, unknown> = {};
  const ctx = vm.createContext({ ...globals, exports: sink });
  const decls = vm.runInContext(PROGRAM, ctx, { filename: "extracted-worker-sandbox-decls.js" }) as Decls;
  return { seedAuth: decls.seedAuth, writePrivate: decls.writePrivate, exports: sink };
}

// ---- fakes ---------------------------------------------------------------
const HOST_HOME = "/fake/host-home";                 // stands in for os.homedir()
const HOST_CRED = `${HOST_HOME}/.claude/.credentials.json`;
const HOST_CODEX = `${HOST_HOME}/.codex/auth.json`;
const WORKER = "/fake/worker-home";
const CWD = "/fake/target-cwd";
const KEYCHAIN_ARGV = ["find-generic-password", "-s", "Claude Code-credentials", "-w"];

// Fabricated; not derived from any real token. The sentinel must never surface
// in a thrown message.
const SENTINEL = "SYNTHETIC-SENTINEL-DO-NOT-LEAK-7f3a";
const F = {
  both: JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS-A", refreshToken: "FAKE-REFRESH-B", expiresAt: 4102444800000, scopes: ["user:inference"], subscriptionType: "max" } }),
  accessOnly: JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS-A" } }),
  refreshOnly: JSON.stringify({ claudeAiOauth: { refreshToken: "FAKE-REFRESH-B" } }),
  expiredWithRefresh: JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS-EXPIRED", refreshToken: "FAKE-REFRESH-B", expiresAt: 1 } }),
  noExpiry: JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS-A", refreshToken: "FAKE-REFRESH-B" } }),
  keychain: JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS-KEYCHAIN", refreshToken: "FAKE-REFRESH-KEYCHAIN" } }),
  malformed: `{"claudeAiOauth": {"accessToken": "${SENTINEL}",`,
};

// A recorded call keeps the options exactly as the product passed them: an omitted
// `mode` is recorded as a present-but-undefined `mode`, which is itself evidence.
// Under `exactOptionalPropertyTypes` that has to be spelled out, so each optional
// field admits `undefined` as a value as well as being absent.
interface Write { p: string; data: string; mode?: number | undefined; flag?: string | undefined }
interface Mkdir { p: string; mode?: number | undefined; recursive?: boolean | undefined }

function makeFakeFs(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed));
  const dirs = new Set([HOST_HOME, `${HOST_HOME}/.claude`, "/fake", "/"]);
  const writes: Write[] = [];
  const mkdirs: Mkdir[] = [];
  const reads: string[] = [];
  return {
    files, writes, mkdirs, reads,
    api: {
      existsSync(p: string) { return files.has(p) || dirs.has(p); },
      readFileSync(p: string) {
        reads.push(p);
        if (!files.has(p)) { const e: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`); e.code = "ENOENT"; throw e; }
        return files.get(p)!;
      },
      writeFileSync(p: string, data: string, opts?: { mode?: number; flag?: string }) {
        writes.push({ p, data, mode: opts?.mode, flag: opts?.flag });
        if (opts?.flag === "wx" && files.has(p)) { const e: NodeJS.ErrnoException = new Error(`EEXIST: ${p}`); e.code = "EEXIST"; throw e; }
        files.set(p, data);
      },
      mkdirSync(p: string, opts?: { mode?: number; recursive?: boolean }) {
        mkdirs.push({ p, mode: opts?.mode, recursive: opts?.recursive });
        dirs.add(p);
        return undefined;
      },
    },
  };
}

// Pure string operations; no filesystem reach.
const fakePath = {
  join: path.posix.join, dirname: path.posix.dirname, basename: path.posix.basename,
  parse: path.posix.parse, isAbsolute: path.posix.isAbsolute, sep: "/", delimiter: ":",
};

interface RunOpts {
  cli?: string;
  // An explicit `undefined` is the meaningful "selected source absent" case, so
  // under `exactOptionalPropertyTypes` the field admits `undefined` as a value.
  hostFile?: string | undefined;  // undefined => selected source absent
  keychain?: string | null;     // null => fake "item not found"
  home?: string;
  env?: Record<string, string>;
  prefill?: Record<string, string>;
  oauthSelected?: boolean;       // #1232: the opted-in worker token flag prepareWorkerSandbox passes
}

// ---- vm-realm boundary ---------------------------------------------------
// Objects and arrays built *inside* the vm context carry that context's
// Object.prototype / Array.prototype. `assert/strict`'s deepStrictEqual compares
// prototype identity, so a cross-realm value fails against a host-realm literal
// even when every key and value matches — a false negative about realms, not
// about seedAuth. The two JSON-like evidence values that cross the boundary (the
// returned env record and the argv the product handed to execFileSync) are
// therefore re-materialised in the host realm by copying their exact own
// enumerable entries. Nothing is weakened: extra keys, missing keys, changed
// values, wrong length and wrong element types all still fail, and the shape is
// asserted here rather than assumed.

/** Host-realm copy of a cross-realm plain record; null/undefined pass through as null. */
function hostRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  assert.equal(typeof v, "object", "expected seedAuth to return an object");
  assert.equal(Array.isArray(v), false, "expected a record, not an array");
  return Object.fromEntries(Object.entries(v as Record<string, unknown>));
}

/** Host-realm copy of a cross-realm array. `Array.isArray` is realm-agnostic. */
function hostList(v: unknown): unknown[] {
  assert.ok(Array.isArray(v), "expected an array");
  return Array.from(v as unknown[]);
}

function runSeed(opts: RunOpts) {
  const cli = opts.cli ?? "claude";
  const home = opts.home ?? `${WORKER}/w`;
  const seed: Record<string, string> = { ...opts.prefill };
  if (opts.hostFile !== undefined) seed[cli === "codex" ? HOST_CODEX : HOST_CRED] = opts.hostFile;
  const ffs = makeFakeFs(seed);
  // `args` is a vm-realm array literal. It is captured raw and normalised below,
  // outside seedAuth's try/catch, so a shape assertion here could never be
  // swallowed into `threw` and mistaken for a product refusal.
  const rawCalls: Array<{ file: string; args: unknown }> = [];
  const execFileSync = (file: string, args: string[]) => {
    rawCalls.push({ file, args });
    if (file !== "/usr/bin/security" || JSON.stringify(args) !== JSON.stringify(KEYCHAIN_ARGV)) {
      throw new Error(`FAKE_EXEC_UNEXPECTED: ${file}`);
    }
    if (opts.keychain === undefined || opts.keychain === null) {
      const e: NodeJS.ErrnoException & { status?: number } = new Error("fake: item not found");
      e.status = 44;
      throw e;
    }
    return opts.keychain;
  };
  const { seedAuth } = load({
    fs: ffs.api, path: fakePath, os: { homedir: () => HOST_HOME },
    process: { platform: "darwin", env: opts.env ?? {} }, execFileSync,
  });
  let threw: Error | null = null;
  let env: Record<string, string> | null = null;
  try { env = seedAuth(cli, home, CWD, opts.oauthSelected ?? false); } catch (e) { threw = e as Error; }
  const sourcePath = cli === "codex" ? HOST_CODEX : HOST_CRED;
  return {
    threw,
    env: hostRecord(env),
    keychainCalls: rawCalls.map(c => ({ file: c.file, args: hostList(c.args) })),
    writes: ffs.writes, mkdirs: ffs.mkdirs, reads: ffs.reads,
    seeded: ffs.files.get(`${home}/.claude/.credentials.json`) ?? null,
    seededCodex: ffs.files.get(`${home}/.codex/auth.json`) ?? null,
    sourceUnchanged: opts.hostFile === undefined || ffs.files.get(sourcePath) === opts.hostFile,
    hostWrites: ffs.writes.filter(w => w.p.startsWith(`${HOST_HOME}/`)).map(w => w.p),
    outsideHomeWrites: ffs.writes.filter(w => !w.p.startsWith(`${home}/`)).map(w => w.p),
  };
}

// #1232: confined Claude never reads or copies the host login. Without the opted-in worker token
// seedAuth refuses with one fixed code before any read, Keychain call, mkdir or write.
const REQUIRED = "SANDBOX_AUTH_WORKER_TOKEN_REQUIRED";

// ---- T1: no opt-in is a refusal, whatever the host holds ------------------
const hostStates: Array<[string, RunOpts]> = [
  ["host file with access and refresh", { hostFile: F.both }],
  ["host file with expired access and refresh", { hostFile: F.expiredWithRefresh }],
  ["host file refresh only", { hostFile: F.refreshOnly }],
  ["host file malformed with sentinel", { hostFile: F.malformed }],
  ["no host file, Keychain item present", { hostFile: undefined, keychain: `${F.keychain}\n` }],
  ["no host file, no Keychain item", { hostFile: undefined, keychain: null }],
];

for (const [name, opts] of hostStates) {
  test(`T1 seedAuth without the opt-in refuses with zero reads, Keychain calls and writes: ${name}`, () => {
    const r = runSeed({ ...opts, home: `${WORKER}/t1-${name.replace(/[^A-Za-z0-9]+/g, "-")}` });
    assert.ok(r.threw, "expected seedAuth to throw");
    assert.equal(r.threw!.message, REQUIRED, "error must be the one stable non-secret code");
    assert.equal(r.env, null);
    assert.deepEqual(r.reads, [], "no host credential read");
    assert.deepEqual(r.keychainCalls, [], "no Keychain invocation");
    assert.deepEqual(r.writes, [], "refusal must happen before any write");
    assert.deepEqual(r.mkdirs, [], "refusal must happen before any directory creation");
    assert.equal(r.seeded, null, "no .credentials.json is seeded");
    assert.ok(r.sourceUnchanged, "the host source is untouched");
    const text = `${r.threw!.message}\n${r.threw!.stack ?? ""}`;
    assert.ok(!text.includes(SENTINEL), "synthetic credential sentinel leaked into the error");
    assert.ok(!text.includes(HOST_CRED), "source path leaked into the error");
    assert.equal(Object.prototype.hasOwnProperty.call(r.threw, "cause"), false, "the refusal must not attach a cause");
    assert.ok(!inspect(r.threw, { depth: 10, showHidden: true }).includes(SENTINEL),
      "synthetic credential sentinel reachable from the error object");
  });
}

// ---- T2: opted in, only the non-credential config is staged ---------------
for (const [name, opts] of hostStates) {
  test(`T2 seedAuth with the opt-in writes only .claude.json and settings.json (0600 wx), no host read: ${name}`, () => {
    const home = `${WORKER}/t2-${name.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const r = runSeed({ ...opts, home, oauthSelected: true });
    assert.equal(r.threw, null, `unexpected throw: ${r.threw?.message}`);
    assert.deepEqual(r.env, {
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    assert.deepEqual(r.writes.map(w => ({ p: w.p, mode: w.mode, flag: w.flag })), [
      { p: `${home}/.claude/.claude.json`, mode: 0o600, flag: "wx" },
      { p: `${home}/.claude/settings.json`, mode: 0o600, flag: "wx" },
    ]);
    assert.ok(r.mkdirs.every(m => m.mode === 0o700 && m.recursive === true));
    assert.equal(r.seeded, null, "no .credentials.json is seeded");
    assert.deepEqual(r.reads, [], "no host credential read");
    assert.deepEqual(r.keychainCalls, [], "no Keychain invocation");
    assert.deepEqual(r.hostWrites, [], "no write may land under the host home");
    assert.deepEqual(r.outsideHomeWrites, [], "no write may land outside the sandbox HOME");
    assert.ok(r.sourceUnchanged, "the host source is untouched");
  });
}

test("wx still refuses to overwrite an already-staged worker config", () => {
  const home = `${WORKER}/reuse`;
  const r = runSeed({
    hostFile: F.both, home, oauthSelected: true,
    prefill: { [`${home}/.claude/.claude.json`]: "{}" },
  });
  assert.ok(r.threw);
  assert.match(r.threw!.message, /EEXIST/);
});

// ---- the Codex branch is untouched --------------------------------------
test("the codex branch is unchanged: no material guard, same two writes", () => {
  const home = `${WORKER}/codex`;
  const r = runSeed({ cli: "codex", hostFile: "{}", home });
  assert.equal(r.threw, null, `codex must not gain the claude guard: ${r.threw?.message}`);
  assert.equal(r.seededCodex, "{}");
  assert.deepEqual(r.env, { CODEX_HOME: `${home}/.codex` });
  assert.deepEqual(r.writes.map(w => ({ p: w.p, mode: w.mode, flag: w.flag })), [
    { p: `${home}/.codex/auth.json`, mode: 0o600, flag: "wx" },
    { p: `${home}/.codex/config.toml`, mode: 0o600, flag: "wx" },
  ]);
  assert.deepEqual(r.hostWrites, []);
  assert.ok(r.sourceUnchanged);
});

/** Identifiers and string/template literal texts under `nodes`. Code only: comments are trivia, never AST nodes. */
function codeTokens(nodes: readonly unknown[]): { ids: Set<string>; literals: string[] } {
  const ids = new Set<string>(), literals: string[] = [];
  const visit = (n: any): void => {
    if (ts.isIdentifier(n)) ids.add(n.text);
    else if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) literals.push(n.text);
    ts.forEachChild(n, visit);
  };
  nodes.forEach(visit);
  return { ids, literals };
}

test("the refusal is confined to the claude branch, names one stable error and no host credential source", () => {
  const decl = DECLS.get("seedAuth")!;
  const codexBranch = decl.slice(decl.indexOf('if (cli === "codex")'), decl.indexOf('if (cli === "claude")'));
  assert.ok(!codexBranch.includes(REQUIRED), "the codex branch must not reference the claude refusal");
  assert.equal(decl.split(REQUIRED).length - 1, 1, "exactly one stable error code, thrown once");
  assert.ok(!/SANDBOX_AUTH_WORKER_TOKEN_REQUIRED[^"]/.test(decl), "the error string must carry no interpolated detail");
  // #1232 F1: the host-read/copy prohibition is checked on CODE (identifiers + literals from the claude branch to the end of
  // seedAuth, as before), so prose in a comment can neither fail nor satisfy it.
  const sf = ts.createSourceFile("seedAuth.ts", decl, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fn = sf.statements[0];
  assert.ok(ts.isFunctionDeclaration(fn) && fn.body, "seedAuth parsed as one function declaration");
  const body = fn.body.statements as readonly any[];
  const at = body.findIndex((s) => ts.isIfStatement(s) && s.expression.getText(sf) === 'cli === "claude"');
  assert.ok(at > 0, "claude branch located in the AST");
  const { ids, literals } = codeTokens(body.slice(at));
  // Positive controls: the walk sees the branch's real code, so the absences below are not vacuous.
  for (const lit of [REQUIRED, ".claude.json", "settings.json"]) assert.ok(literals.includes(lit), `walk misses literal ${lit}`);
  assert.ok(ids.has("writePrivate") && ids.has("oauthSelected"), "walk misses the branch identifiers");
  for (const id of ["execFileSync", "readFileSync"]) {
    assert.ok(!ids.has(id), `the claude branch must not reference ${id}`);
  }
  for (const gone of ["/usr/bin/security", "Claude Code-credentials", ".credentials.json", "SANDBOX_AUTH_INVALID_SEED"]) {
    assert.ok(!literals.some((l) => l.includes(gone)), `the claude branch must not reference ${gone}`);
  }
});

test("the candidate declarations contain no destructive or host-directed fs call", () => {
  const both = `${DECLS.get("seedAuth")}${DECLS.get("writePrivate")}`;
  for (const m of ["unlinkSync", "rmSync", "rmdirSync", "truncateSync", "renameSync", "copyFileSync", "chmodSync", "openSync"]) {
    assert.ok(!new RegExp(`\\bfs\\.${m}\\b`).test(both), `unexpected destructive call fs.${m}`);
  }
});

// ---- evaluation shape ----------------------------------------------------
test("the erased declarations need a context-owned exports object and publish exactly writePrivate", () => {
  assert.throws(() => vm.runInContext(PROGRAM, vm.createContext({})), (e: Error) =>
    e.name === "ReferenceError" && /\bexports is not defined\b/.test(e.message),
    "without the sink the CommonJS export assignment must fail, not be silently absorbed");
  const d = load({});
  assert.deepEqual(Object.keys(d.exports), EXPECTED_EXPORTS, "export surface of the extracted declarations");
  assert.equal(typeof d.writePrivate, "function");
  assert.equal(typeof d.seedAuth, "function");
  assert.equal(d.exports.writePrivate, d.writePrivate, "the export is the evaluated declaration itself");
  assert.equal((d.exports.writePrivate as Decls["writePrivate"]).name, "writePrivate");
  assert.equal(Object.prototype.hasOwnProperty.call(d.exports, "seedAuth"), false, "seedAuth stays module-private");
  assert.notEqual(load({}).exports, load({}).exports, "each evaluation gets its own exports sink");
});

test("the exported writePrivate keeps 0700 recursive mkdir, 0600 wx write and no overwrite", () => {
  const ffs = makeFakeFs({});
  const d = load({ fs: ffs.api, path: fakePath });
  const write = d.exports.writePrivate as Decls["writePrivate"];
  const file = `${WORKER}/export/.claude/.credentials.json`;
  write(file, F.both);
  assert.deepEqual(ffs.mkdirs, [{ p: `${WORKER}/export/.claude`, mode: 0o700, recursive: true }]);
  assert.deepEqual(ffs.writes, [{ p: file, data: F.both, mode: 0o600, flag: "wx" }]);
  assert.throws(() => write(file, F.accessOnly), /EEXIST/);
  assert.equal(ffs.files.get(file), F.both, "wx must leave the first bytes in place");
});
