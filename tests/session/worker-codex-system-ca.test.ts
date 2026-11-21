// #652 — AIGENTRY_CODEX_SYSTEM_CA: the opt-in that hands a confined Codex worker the CA
// bundle FILE macOS ships, and the checks that can refuse it.
//
// The option does not validate one pathname and then hand over that pathname. It resolves
// the chain ONCE, validates the RESOLVED file and every directory component above it, and
// hands the worker the resolved path. So the assertions here are about (a) which object was
// inspected, (b) which path the sealed environment receives, and (c) which conditions drop
// the option — including a replaceable PARENT of a perfectly good file, which a check on
// the file alone would accept.
//
// `seedAuth` is taken from the TypeScript source by AST node position
// (ts.createSourceFile → FunctionDeclaration → getStart/getEnd), type-erased with
// ts.transpileModule and evaluated in a node:vm context whose only bindings are the
// explicit fakes below — the same technique as tests/session/worker-auth-seed.test.ts,
// which pins the rest of this function's behaviour. The REAL declaration runs; only its
// process boundary is replaced. The platform, the opt-in, the filesystem layout and the
// effective uid are INJECTED, which is what makes the Darwin-only arm, the root-owned arm
// and the symlink arm measurable off macOS, without root and without touching /etc.
//
// Scope: this proves which environment variable the sealed manifest gets, for which object,
// under which metadata. It does NOT prove that the OS trusts that bundle, that the bundle
// is readable from inside the sandbox, or that the Codex client honours the variable —
// those are measurements, recorded with the change that introduced the option.
//
// Portable: pure string/JSON work in one vm context, so it runs on every OS the runner
// collects compiled tests on, win32 included. No case is skipped on any platform.
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

/** The path the option asks for. Pinned literally, not read from the module. */
const REQUESTED = "/etc/ssl/cert.pem";
/** Where it resolves on a stock macOS layout: /etc is itself a symlink to /private/etc. */
const RESOLVED = "/private/etc/ssl/cert.pem";
const OPT_IN = "AIGENTRY_CODEX_SYSTEM_CA";
const HOST_HOME = "/fake/host-home";
const WORKER_HOME = "/fake/worker-home";
const CWD = "/fake/target-cwd";
/** Fabricated; not derived from any real credential. */
const FAKE_CODEX_AUTH = JSON.stringify({ fake: "FAKE-652-NOT-A-SECRET" });

const R_OK = 4, W_OK = 2;
type Kind = "file" | "dir" | "link";
interface Node { kind: Kind; uid: number; mode: number; target?: string }
/** The in-memory layout the fake fs answers from. Absolute paths, no "." or "..". */
type Layout = Record<string, Node>;

const dir = (uid = 0, mode = 0o040755): Node => ({ kind: "dir", uid, mode });
const file = (uid = 0, mode = 0o100644): Node => ({ kind: "file", uid, mode });
const link = (target: string): Node => ({ kind: "link", uid: 0, mode: 0o120755, target });

/**
 * The stock macOS layout: a SYMLINKED /etc/ssl/cert.pem whose target and whose every
 * parent is root-owned and not group/other-writable. This is the accepted case, and it is
 * deliberately the default so that every rejection fixture below is one mutation away
 * from a bundle that works.
 */
function stockLayout(): Layout {
  return {
    "/": dir(),
    "/etc": link("/private/etc"),
    "/private": dir(),
    "/private/etc": dir(),
    "/private/etc/ssl": dir(),
    [RESOLVED]: file(),
  };
}

const errno = (code: string, p: string): never => {
  const e: NodeJS.ErrnoException = new Error(`${code}: ${p}`);
  e.code = code;
  throw e;
};

interface Opts {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  layout?: Layout;
  /** Paths THIS process may write (the ACL backstop's view). */
  writable?: string[];
  /** `false` = R_OK on the resolved bundle throws EACCES. */
  readable?: boolean;
  /** Effective uid of the host process; 0 disables the W_OK backstop. */
  uid?: number;
  /** The layout every call sees AFTER the first realpathSync returns: a swap in the race window. */
  afterResolve?: Layout;
}
interface Result {
  env: Record<string, unknown> | null;
  threw: Error | null;
  warnings: string[];
  /** Every path handed to lstat/realpath, in order. */
  inspected: string[];
  /** Every `access` call as "<path>:<mode>". */
  accessed: string[];
  writes: string[];
}

function seed(opts: Opts = {}): Result {
  const platform = opts.platform ?? "darwin";
  let layout = opts.layout ?? stockLayout();
  const writable = new Set(opts.writable ?? []);
  const readable = opts.readable ?? true;
  const uid = opts.uid ?? 501;
  const warnings: string[] = [];
  const inspected: string[] = [];
  const accessed: string[] = [];
  const writes: string[] = [];
  const files = new Map<string, string>([[`${HOST_HOME}/.codex/auth.json`, FAKE_CODEX_AUTH]]);

  /** Component-by-component resolution, following absolute symlinks. */
  const realpath = (p: string): string => {
    let cur = "";
    for (const part of p.split("/").filter(Boolean)) {
      cur = `${cur}/${part}`;
      let node: Node | undefined = layout[cur];
      for (let hops = 0; node && node.kind === "link"; hops += 1) {
        if (hops > 8) errno("ELOOP", cur);
        cur = node.target!;
        node = layout[cur];
      }
      if (!node) errno("ENOENT", cur);
    }
    return cur;
  };

  const fakeFs = {
    constants: { R_OK, W_OK, X_OK: 1 },
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => (files.has(p) ? files.get(p)! : errno("ENOENT", p)),
    mkdirSync: () => undefined,
    writeFileSync: (p: string, data: string) => { writes.push(p); files.set(p, data); },
    realpathSync: (p: string) => {
      inspected.push(p);
      const out = realpath(p);
      if (opts.afterResolve) layout = opts.afterResolve;
      return out;
    },
    lstatSync: (p: string) => {
      inspected.push(p);
      const node = layout[p] ?? errno("ENOENT", p);
      return { isFile: () => node.kind === "file", isDirectory: () => node.kind === "dir", uid: node.uid, mode: node.mode };
    },
    accessSync: (p: string, mode: number) => {
      accessed.push(`${p}:${mode}`);
      if (mode === W_OK) { if (!writable.has(p)) errno("EACCES", p); return; }
      if (!readable) errno("EACCES", p);
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
      getuid: () => uid,
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
  return { env, threw, warnings, inspected, accessed, writes };
}

const CODEX_HOME = `${WORKER_HOME}/.codex`;
/** The resolved file first, then every directory component up to and including "/". */
const FULL_CHAIN = [REQUESTED, RESOLVED, "/private/etc/ssl", "/private/etc", "/private", "/"];

/** Every arm must still seed the two codex files and must never throw. */
function assertSeededNormally(r: Result): void {
  assert.equal(r.threw, null, `seedAuth must not fail over an optional CA: ${r.threw?.message}`);
  assert.deepEqual(r.writes, [`${CODEX_HOME}/auth.json`, `${CODEX_HOME}/config.toml`]);
}

test("#652: opt-out is the default — an unset opt-in adds nothing and inspects no file", () => {
  const r = seed();
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME });
  assert.deepEqual(r.inspected, [], "nothing may be resolved or stat()ed when the opt-in is unset");
  assert.deepEqual(r.accessed, []);
  assert.deepEqual(r.warnings, []);
});

test("#652: only the exact value `1` opts in; other values add nothing and warn nothing", () => {
  for (const value of ["0", "", "true", "yes", "2", "01", " 1"]) {
    const r = seed({ env: { [OPT_IN]: value } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `value ${JSON.stringify(value)} must not opt in`);
    assert.deepEqual(r.inspected, [], `value ${JSON.stringify(value)} must not inspect the bundle`);
    assert.deepEqual(r.warnings, []);
  }
});

test("#652: the opt-in is Darwin-only — on any other platform nothing is added and nothing is read", () => {
  for (const platform of ["linux", "win32", "freebsd", "aix"] as NodeJS.Platform[]) {
    const r = seed({ platform, env: { [OPT_IN]: "1" } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `${platform} must not get the CA variable`);
    assert.deepEqual(r.inspected, [], `${platform} must not inspect the bundle`);
    assert.deepEqual(r.warnings, [], `${platform} must not warn about an option it never offered`);
  }
});

// ── the check and the handover are bound to the SAME object ────────────────────────────
test("#652: the worker is handed the RESOLVED path, not the symlink it asked for", () => {
  const r = seed({ env: { [OPT_IN]: "1" } });
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME, CODEX_CA_CERTIFICATE: RESOLVED },
    "the sealed environment must carry the path whose metadata was actually checked");
  assert.notEqual(r.env!.CODEX_CA_CERTIFICATE, REQUESTED,
    "handing over the pre-resolution path leaves the worker's open bound to a different object");
});

test("#652: the resolution happens once and every component of the resolved path is checked", () => {
  const r = seed({ env: { [OPT_IN]: "1" } });
  assert.deepEqual(r.inspected, FULL_CHAIN,
    "exactly one realpath of the requested path, then the resolved file and each parent up to /");
  assert.equal(r.inspected.filter((p) => p === REQUESTED).length, 1, "the chain is resolved exactly once");
  assert.deepEqual(r.accessed, [
    `${RESOLVED}:${R_OK}`,
    ...FULL_CHAIN.slice(1).map((p) => `${p}:${W_OK}`),
  ], "readability is checked on the resolved file, and effective write access on the whole chain");
});

test("#652: a replaceable PARENT drops the option even when the bundle itself is perfect", () => {
  // A check that stat()ed the file and nothing else would accept every one of these.
  const cases: Array<[string, Layout, RegExp]> = [
    ["group-writable parent", { ...stockLayout(), "/private/etc/ssl": dir(0, 0o040775) },
      /under a group\/other-writable directory \(\/private\/etc\/ssl, mode 775\)/],
    ["other-writable grandparent", { ...stockLayout(), "/private/etc": dir(0, 0o040757) },
      /under a group\/other-writable directory \(\/private\/etc, mode 757\)/],
    ["non-root-owned parent", { ...stockLayout(), "/private/etc/ssl": dir(501) },
      /under a non-root-owned directory \(\/private\/etc\/ssl, uid 501\)/],
    ["non-root-owned root", { ...stockLayout(), "/": dir(501) },
      /under a non-root-owned directory \(\/, uid 501\)/],
    ["world-writable root", { ...stockLayout(), "/": dir(0, 0o040777) },
      /under a group\/other-writable directory \(\/, mode 777\)/],
  ];
  for (const [label, layout, expected] of cases) {
    const r = seed({ env: { [OPT_IN]: "1" }, layout });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `${label}: a replaceable chain must add no CA variable`);
    assert.equal(r.warnings.length, 1, `${label}: exactly one warning`);
    assert.match(r.warnings[0]!, expected, label);
    assert.match(r.warnings[0]!, /CODEX_CA_CERTIFICATE not set\n$/, label);
  }
});

test("#652: a component this non-root process can write is refused (the ACL backstop)", () => {
  // st_mode cannot see an extended ACL; access(W_OK) can, for this process. Each of these
  // layouts is mode-clean, so only the W_OK pass can catch it.
  for (const target of [RESOLVED, "/private/etc/ssl", "/"]) {
    const r = seed({ env: { [OPT_IN]: "1" }, writable: [target] });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME }, `a writable ${target} must drop the option`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, new RegExp(`writable by this non-root process \\(${target.replace(/\//g, "\\/")}\\)`));
  }
});

test("#652: as root the W_OK backstop is skipped, because it could only ever say yes", () => {
  const r = seed({ env: { [OPT_IN]: "1" }, uid: 0, writable: [RESOLVED, "/private/etc/ssl", "/"] });
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME, CODEX_CA_CERTIFICATE: RESOLVED });
  assert.deepEqual(r.accessed, [`${RESOLVED}:${R_OK}`],
    "a root host checks readability only; W_OK carries no information for uid 0");
});

test("#652: a symlink that appears after the resolve is not a regular file", () => {
  // lstat (not stat) on the resolved path: the only way this node can be a link is that it
  // became one after realpathSync returned, which is exactly the swap being guarded against.
  // So realpathSync answers from the stock layout, and only the calls AFTER it see the link
  // (a fixture link present from the start would simply be followed by realpathSync). The
  // link's target is a regular file, so following it (stat) would accept the swap.
  const swapped = {
    ...stockLayout(),
    [RESOLVED]: link("/private/etc/ssl/other.pem"),
    "/private/etc/ssl/other.pem": file(),
  };
  const r = seed({ env: { [OPT_IN]: "1" }, afterResolve: swapped });
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /is not a regular file/);
  assert.match(r.warnings[0]!, /\/etc\/ssl\/cert\.pem → \/private\/etc\/ssl\/cert\.pem is not a regular file/,
    "the refusal must come from the post-resolve lstat, after realpath returned the resolved path");
  assert.deepEqual(r.inspected, [REQUESTED, RESOLVED], "resolved once, then lstat on the resolved path, which refuses");
});

test("#652: the warning names both the requested path and what it resolved to", () => {
  const layout = { ...stockLayout(), [RESOLVED]: file(501) };
  const r = seed({ env: { [OPT_IN]: "1" }, layout });
  assert.match(r.warnings[0]!, /\/etc\/ssl\/cert\.pem → \/private\/etc\/ssl\/cert\.pem is not root-owned \(uid 501\)/,
    "a reader must be able to see WHICH object was refused, not just which one was asked for");
});

test("#652: an unresolvable chain is reported as unusable, naming the requested path only", () => {
  const layout = { ...stockLayout() };
  delete layout[RESOLVED];
  const r = seed({ env: { [OPT_IN]: "1" }, layout });
  assertSeededNormally(r);
  assert.deepEqual(r.env, { CODEX_HOME });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /^worker-sandbox: AIGENTRY_CODEX_SYSTEM_CA=1 ignored — \/etc\/ssl\/cert\.pem is unusable \(ENOENT\)/);
});

// ── the metadata gates on the bundle itself ───────────────────────────────────────────
test("#652: an acceptable bundle — regular file, root-owned, not group/other-writable — is passed", () => {
  // 0644 and the stricter 0444/0400/0600: each is root-owned with no write bit outside owner.
  for (const mode of [0o100644, 0o100444, 0o100400, 0o100600]) {
    const r = seed({ env: { [OPT_IN]: "1" }, layout: { ...stockLayout(), [RESOLVED]: file(0, mode) } });
    assertSeededNormally(r);
    assert.deepEqual(r.env, { CODEX_HOME, CODEX_CA_CERTIFICATE: RESOLVED },
      `mode ${mode.toString(8)} must be accepted`);
    assert.deepEqual(r.inspected, FULL_CHAIN, "exactly the requested path and its resolved chain");
    assert.deepEqual(r.warnings, []);
  }
});

test("#652: a rejected bundle adds NOTHING and warns precisely — owner, mode, type, access", () => {
  const cases: Array<[string, Opts, RegExp]> = [
    ["not root-owned", { layout: { ...stockLayout(), [RESOLVED]: file(501) } }, /not root-owned \(uid 501\)/],
    ["root but group-writable", { layout: { ...stockLayout(), [RESOLVED]: file(0, 0o100664) } },
      /group\/other-writable \(mode 664\)/],
    ["root but other-writable", { layout: { ...stockLayout(), [RESOLVED]: file(0, 0o100646) } },
      /group\/other-writable \(mode 646\)/],
    ["world-writable", { layout: { ...stockLayout(), [RESOLVED]: file(0, 0o100666) } },
      /group\/other-writable \(mode 666\)/],
    ["not a regular file", { layout: { ...stockLayout(), [RESOLVED]: dir(0, 0o040755) } }, /not a regular file/],
    ["unreadable", { readable: false }, /unusable \(EACCES\)/],
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
    assert.ok(warning.includes(REQUESTED), `${label}: the warning must name the path it refused`);
    // A refusal must not leak the host's own layout or any credential byte.
    assert.ok(!warning.includes(HOST_HOME) && !warning.includes(FAKE_CODEX_AUTH),
      `${label}: the warning must carry no home path and no credential material`);
  }
});

test("#652: the option sets CODEX_CA_CERTIFICATE only — it never widens the rest of the environment", () => {
  const accepted = seed({ env: { [OPT_IN]: "1" } });
  const optedOut = seed();
  assert.deepEqual(Object.keys(accepted.env!).sort(), ["CODEX_CA_CERTIFICATE", "CODEX_HOME"]);
  // Exactly one key more than opt-out, and the same CODEX_HOME.
  assert.deepEqual(Object.keys(optedOut.env!), ["CODEX_HOME"]);
  assert.equal(accepted.env!.CODEX_HOME, optedOut.env!.CODEX_HOME);
});

// ── source-level guards ───────────────────────────────────────────────────────────────
/** The codex arm of the real declaration, and its comment text with `//` prefixes removed. */
function codexBranch(): { code: string; prose: string } {
  const decl = DECLS.get("seedAuth")!;
  const code = decl.slice(decl.indexOf('if (cli === "codex")'), decl.indexOf('if (cli === "claude")'));
  const prose = code.replace(/^[ \t]*\/\/[ \t]?/gm, "").replace(/\s+/g, " ");
  return { code, prose };
}

test("#652: the source pins the fixed public path, the resolve-then-check order and the gates", () => {
  const { code } = codexBranch();
  assert.ok(code.includes(`"${REQUESTED}"`), "the bundle path must be the fixed OS path, written literally");
  assert.ok(code.includes("fs.realpathSync(requested)"), "the chain must be resolved before anything is judged");
  assert.ok(code.indexOf("fs.realpathSync") < code.indexOf("fs.lstatSync"),
    "the resolve must come first, or the metadata would describe a different object");
  assert.ok(code.includes("st.uid !== 0") && code.includes("ds.uid !== 0"),
    "the root-owner gate must be applied to the file AND to each directory component");
  assert.equal(code.split("0o022").length - 1, 2,
    "the group/other-writable gate must be applied to the file AND to each directory component");
  assert.ok(/tlsEnv\.CODEX_CA_CERTIFICATE = resolved;/.test(code),
    "the worker must be handed the resolved path — the one the checks were run on");
  assert.ok(!/tlsEnv\.CODEX_CA_CERTIFICATE = (requested|ca|"\/etc)/.test(code),
    "handing over the unresolved path would bind the worker's open to an unchecked object");
  assert.ok(code.includes('process.platform === "darwin"'), "the option must stay Darwin-only");
  assert.ok(code.includes('process.env.AIGENTRY_CODEX_SYSTEM_CA === "1"'), "the opt-in must be an exact match on 1");
  assert.ok(!/throw new Error\([^)]*CA/i.test(code), "a rejected bundle must warn, never throw");
  // No snapshot/stage path: the existing suite forbids fs.openSync/copyFileSync inside this
  // declaration (tests/session/worker-auth-seed.test.ts), so the chain walk is the mechanism.
  assert.ok(!/fs\.(openSync|copyFileSync|renameSync|chmodSync)\b/.test(code),
    "the declaration must keep the host-directed fs.* surface the existing suite pins");
});

test("#652: the option's own documentation claims only what this code establishes", () => {
  const { prose } = codexBranch();
  // Must disclose, in the source a maintainer reads first:
  for (const must of [
    /is NOT "the system trust"/,
    /Keychain and trustd/,
    /may differ IN EITHER DIRECTION/,
    /neither a subset nor a superset/,
    /ADDS these roots to any it already has or REPLACES them/,
    /BOTH CODEX_CA_CERTIFICATE and SSL_CERT_FILE set/,
    /does not isolate which variable the client honoured/,
    /TOCTOU/,
    /st_mode cannot see a macOS extended ACL/,
    /Host readability is not readability inside the confinement/,
    /resolved pathname is what the worker is handed/,
  ]) {
    assert.match(prose, must, `the option's documentation must state: ${must}`);
  }
  // Must NOT claim what no code here checks:
  for (const mustNot of [
    /additive-only/i,
    /equivalent to (the )?(macOS |host )?(effective )?(system )?trust/i,
    /same (anchors|roots) as the (system|host)/i,
    /is the PUBLIC trust store/i,
    /preserv\w* the client's (prior|existing) roots/i,
  ]) {
    assert.doesNotMatch(prose, mustNot, `the option's documentation must not claim: ${mustNot}`);
  }
});
