// #652 — AIGENTRY_CODEX_SYSTEM_CA: the opt-in that hands the macOS public CA bundle to a
// confined Codex worker, and the metadata checks that can refuse it.
//
// Covers the four arms of the opt-in: unset (nothing added), a non-Darwin platform
// (nothing added), an acceptable bundle (CODEX_CA_CERTIFICATE set to the fixed OS path),
// and a rejected bundle — wrong owner, group/other-writable, not a regular file, missing
// or unreadable — where NOTHING is added and a precise warning is written instead.
//
// `seedAuth` is taken from the TypeScript source by AST node position
// (ts.createSourceFile → FunctionDeclaration → getStart/getEnd), type-erased with
// ts.transpileModule and evaluated in a node:vm context whose only bindings are the
// explicit fakes below — the same technique as tests/session/worker-auth-seed.test.ts,
// which pins the rest of this function's behaviour. The REAL declaration runs; only its
// process boundary is replaced. The platform and the opt-in are INJECTED, which is what
// makes the Darwin-only arm and the root-owned-file arm measurable off macOS and without
// root: nothing here reads /etc, the developer HOME, a credential store or the network,
// and nothing is written outside the in-memory fake filesystem.
//
// Scope: this proves which environment variable the sealed manifest gets, and under which
// file metadata. It does NOT prove that the OS trusts that bundle, that it is readable
// from inside the sandbox, or that the Codex client honours the variable — those are
// measurements, recorded with the change that introduced the option.
//
// Portable: pure string/JSON work in one vm context, so it runs on every OS the runner
// collects compiled tests on, win32 included.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// `typescript` is already the compiler for this repo's build; used here as a library only
// (parse + type erasure), not as a new dependency.
const ts = require("typescript");

// `scripts/run-tests.mjs` collects `dist/tests/**/*.test.js`, so this file runs as
// `dist/tests/session/worker-codex-system-ca.test.js` and the repo root is exactly three
// levels up. Pinned rather than searched: an ancestor walk could silently bind to some
// OTHER checkout's worker-sandbox.ts and report a green run against source this repo
// never compiled.
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
const ERASED = ts.transpileModule(`${DECLS.get("writePrivate")}\n${DECLS.get("seedAuth")}\n`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true },
}).outputText;
// `writePrivate` is exported in the source, so the CommonJS emit assigns to `exports`;
// each evaluation gets its own sink for that assignment.
const PROGRAM = `${ERASED}\n;({ seedAuth });`;

/** The fixed OS path the option selects. Pinned literally, not read from the module. */
const CA = "/etc/ssl/cert.pem";
const OPT_IN = "AIGENTRY_CODEX_SYSTEM_CA";
const HOST_HOME = "/fake/host-home";
const WORKER_HOME = "/fake/worker-home";
const CWD = "/fake/target-cwd";
/** Fabricated; not derived from any real credential. */
const FAKE_CODEX_AUTH = JSON.stringify({ fake: "FAKE-652-NOT-A-SECRET" });

interface StatFixture { isFile: boolean; uid: number; mode: number }
interface Opts {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  /** Absent = statSync throws ENOENT. */
  stat?: StatFixture;
  /** `false` = accessSync throws EACCES. */
  readable?: boolean;
}
interface Result {
  env: Record<string, unknown> | null;
  threw: Error | null;
  warnings: string[];
  statted: string[];
  accessed: string[];
  writes: string[];
}

function seed(opts: Opts = {}): Result {
  const platform = opts.platform ?? "darwin";
  const readable = opts.readable ?? true;
  const warnings: string[] = [];
  const statted: string[] = [];
  const accessed: string[] = [];
  const writes: string[] = [];
  const files = new Map<string, string>([[`${HOST_HOME}/.codex/auth.json`, FAKE_CODEX_AUTH]]);

  const enoent = (p: string): never => {
    const e: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
    e.code = "ENOENT";
    throw e;
  };
  const fakeFs = {
    constants: { R_OK: 4, X_OK: 1 },
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => (files.has(p) ? files.get(p)! : enoent(p)),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string) => { writes.push(p); files.set(p, data); },
    statSync: (p: string) => {
      statted.push(p);
      if (!opts.stat) return enoent(p);
      return { isFile: () => opts.stat!.isFile, uid: opts.stat!.uid, mode: opts.stat!.mode };
    },
    accessSync: (p: string) => {
      accessed.push(p);
      if (readable) return;
      const e: NodeJS.ErrnoException = new Error(`EACCES: ${p}`);
      e.code = "EACCES";
      throw e;
    },
  };
  const ctx = vm.createContext({
    fs: fakeFs,
    // path.posix keeps the fixture paths identical on win32, where this test also runs.
    path: { join: path.posix.join, dirname: path.posix.dirname },
    os: { homedir: () => HOST_HOME },
    process: {
      platform,
      env: opts.env ?? {},
      stderr: { write: (s: string) => { warnings.push(s); return true; } },
    },
    execFileSync: () => assert.fail("the codex branch must never reach the Keychain"),
    exports: {},
  }, { name: "extracted-worker-sandbox-decls" });
  const { seedAuth } = vm.runInContext(PROGRAM, ctx) as
    { seedAuth: (cli: string, home: string, cwd: string) => Record<string, string> };

  let env: Record<string, unknown> | null = null;
  let threw: Error | null = null;
  try {
    // Re-materialised in the host realm: assert/strict compares prototype identity, and a
    // record built inside the vm carries that context's Object.prototype.
    const raw = seedAuth("codex", WORKER_HOME, CWD);
    env = Object.fromEntries(Object.entries(raw));
  } catch (e) {
    threw = e as Error;
  }
  return { env, threw, warnings, statted, accessed, writes };
}

const CODEX_HOME = `${WORKER_HOME}/.codex`;

/** Every arm must still seed the two codex files and must never throw. */
function assertSeededNormally(r: Result): void {
  assert.equal(r.threw, null, `seedAuth must not fail over an optional CA: ${r.threw?.message}`);
  assert.deepEqual(r.writes, [`${CODEX_HOME}/auth.json`, `${CODEX_HOME}/config.toml`]);
}

test("#652: opt-out is the default — an unset opt-in adds nothing and inspects no file", () => {
  const r = seed();
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME });
  assert.deepEqual(r.statted, [], "nothing may be stat()ed when the opt-in is unset");
  assert.deepEqual(r.warnings, []);
});

test("#652: only the exact value `1` opts in; other values add nothing and warn nothing", () => {
  for (const value of ["0", "", "true", "yes", "2", "01", " 1"]) {
    const r = seed({ env: { [OPT_IN]: value }, stat: { isFile: true, uid: 0, mode: 0o100644 } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `value ${JSON.stringify(value)} must not opt in`);
    assert.deepEqual(r.statted, [], `value ${JSON.stringify(value)} must not inspect the bundle`);
    assert.deepEqual(r.warnings, []);
  }
});

test("#652: the opt-in is Darwin-only — on any other platform nothing is added and nothing is read", () => {
  for (const platform of ["linux", "win32", "freebsd", "aix"] as NodeJS.Platform[]) {
    const r = seed({ platform, env: { [OPT_IN]: "1" }, stat: { isFile: true, uid: 0, mode: 0o100644 } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `${platform} must not get the CA variable`);
    assert.deepEqual(r.statted, [], `${platform} must not inspect the bundle`);
    assert.deepEqual(r.warnings, [], `${platform} must not warn about an option it never offered`);
  }
});

test("#652: an acceptable bundle — regular file, root-owned, not group/other-writable — is passed", () => {
  // 0644 and the stricter 0444/0400: each is root-owned with no write bit outside owner.
  for (const mode of [0o100644, 0o100444, 0o100400, 0o100600]) {
    const r = seed({ env: { [OPT_IN]: "1" }, stat: { isFile: true, uid: 0, mode } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME, CODEX_CA_CERTIFICATE: CA },
      `mode ${mode.toString(8)} must be accepted`);
    assert.deepEqual(r.statted, [CA], "exactly the one fixed OS path is inspected");
    assert.deepEqual(r.accessed, [CA], "readability is checked as well as the metadata");
    assert.deepEqual(r.warnings, []);
  }
});

test("#652: a rejected bundle adds NOTHING and warns precisely — owner, mode, type, absence, access", () => {
  const cases: Array<[string, Opts, RegExp]> = [
    ["not root-owned", { stat: { isFile: true, uid: 501, mode: 0o100644 } }, /not root-owned \(uid 501\)/],
    ["root but group-writable", { stat: { isFile: true, uid: 0, mode: 0o100664 } }, /group\/other-writable \(mode 664\)/],
    ["root but other-writable", { stat: { isFile: true, uid: 0, mode: 0o100646 } }, /group\/other-writable \(mode 646\)/],
    ["world-writable", { stat: { isFile: true, uid: 0, mode: 0o100666 } }, /group\/other-writable \(mode 666\)/],
    ["not a regular file", { stat: { isFile: false, uid: 0, mode: 0o040755 } }, /not a regular file/],
    ["missing", {}, /unusable \(ENOENT\)/],
    ["unreadable", { stat: { isFile: true, uid: 0, mode: 0o100644 }, readable: false }, /unusable \(EACCES\)/],
  ];
  for (const [label, extra, expected] of cases) {
    const r = seed({ env: { [OPT_IN]: "1" }, ...extra });
    assertSeededNormally(r);
    // The refusal is the WHOLE effect: the sealed environment is what opt-out would give.
    assert.deepEqual(r.env, { CODEX_HOME }, `${label}: no CA variable may be set`);
    assert.equal(r.warnings.length, 1, `${label}: exactly one warning`);
    const warning = r.warnings[0]!;
    assert.match(warning, expected, label);
    assert.match(warning, /^worker-sandbox: AIGENTRY_CODEX_SYSTEM_CA=1 ignored — /, label);
    assert.match(warning, /CODEX_CA_CERTIFICATE not set\n$/, label);
    assert.ok(warning.includes(CA), `${label}: the warning must name the path it refused`);
    // A refusal must not leak the host's own layout or any credential byte.
    assert.ok(!warning.includes(HOST_HOME) && !warning.includes(FAKE_CODEX_AUTH),
      `${label}: the warning must carry no home path and no credential material`);
  }
});

test("#652: the option sets CODEX_CA_CERTIFICATE only — it never widens the rest of the environment", () => {
  const accepted = seed({ env: { [OPT_IN]: "1" }, stat: { isFile: true, uid: 0, mode: 0o100644 } });
  const optedOut = seed();
  assert.deepEqual(Object.keys(accepted.env!).sort(), ["CODEX_CA_CERTIFICATE", "CODEX_HOME"]);
  // Exactly one key more than opt-out, and the same CODEX_HOME.
  assert.deepEqual(Object.keys(optedOut.env!), ["CODEX_HOME"]);
  assert.equal(accepted.env!.CODEX_HOME, optedOut.env!.CODEX_HOME);
});

test("#652: the source pins the fixed public path and the two metadata gates", () => {
  // A source-level guard: the accepted path is a constant, not caller-supplied, and the
  // owner/mode gates are present. An edit that parameterises the path or drops a gate
  // fails here as well as above.
  const decl = DECLS.get("seedAuth")!;
  const branch = decl.slice(decl.indexOf('if (cli === "codex")'), decl.indexOf('if (cli === "claude")'));
  assert.ok(branch.includes(`"${CA}"`), "the bundle path must be the fixed OS path, written literally");
  assert.ok(branch.includes("st.uid !== 0"), "the root-owner gate must be present");
  assert.ok(branch.includes("0o022"), "the group/other-writable gate must be present");
  assert.ok(branch.includes('process.platform === "darwin"'), "the option must stay Darwin-only");
  assert.ok(!/throw new Error\([^)]*CA/i.test(branch), "a rejected bundle must warn, never throw");
});
