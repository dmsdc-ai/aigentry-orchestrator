// #507 / #616 — surface_mismatched handling, both arms of an OPT-IN.
//
// DEFAULT (AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY unset): unchanged from the public
// reconciler — resolve the sid and focus the host. Pinned here because removing that
// actuation for every adapter, with no setting, would take away the only visual cue a Warp
// operator gets; these default-arm cases are the regression guard against that.
// OPT-IN (=1): the event is recorded and NOTHING is focused, raised or selected.
// Both arms count the event and drain the spool identically.
//
// The functions under test are taken from the TypeScript source by AST node position
// (ts.createSourceFile → FunctionDeclaration → getStart/getEnd), type-erased with
// ts.transpileModule and evaluated in a node:vm context whose only bindings are the
// explicit fakes below — the same technique as tests/session/worker-auth-seed.test.ts.
// `consumeSurfaceMismatched` is the real declaration, and so are the real `readLines`,
// `jqField` and `chomp` it parses each line with; only the process boundary is replaced.
// Nothing imports the reconciler, boots a tick, contacts telepty/cmux or a workspace
// host, reads real state or writes anywhere outside this test's own fake filesystem.
//
// Portable and offline: pure string/JSON work in one vm context, so it runs on every OS
// the runner collects compiled tests on, win32 included. No case is skipped anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// `typescript` is already the compiler for this repo's build; used here as a library
// only (parse + type erasure), not as a new dependency.
const ts = require("typescript");

// `scripts/run-tests.mjs` collects `dist/tests/**/*.test.js`, so this file runs as
// `dist/tests/dispatch/surface-mismatch-diagnostic.test.js` and the repo root is exactly
// three levels up. Pinned rather than searched: an ancestor walk could silently bind to
// some OTHER checkout's reconciler and report a green run against source this repo never
// compiled.
const COMPILED_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_TAIL = path.join("dist", "tests", "dispatch");
if (!COMPILED_DIR.endsWith(path.sep + EXPECTED_TAIL)) {
  throw new Error(`expected the compiled test under ${EXPECTED_TAIL}, ran from ${COMPILED_DIR}`);
}
const REPO_ROOT = path.resolve(COMPILED_DIR, "..", "..", "..");
const SOURCE_FILE = path.join(REPO_ROOT, "src", "reconciler", "cli.ts");
if (!fs.existsSync(SOURCE_FILE)) throw new Error(`candidate source not found: ${SOURCE_FILE}`);
// CI checks this repo out with LF on win32 too (ci.yml:1109-1111), but a developer whose
// git sets core.autocrlf=true would otherwise fail the exact-source-line assertion below on
// a trailing CR alone. Normalised before parsing, so AST positions match these bytes.
// Same move as tests/packaging/workflow-policy.test.mjs:21.
const WHOLE = fs.readFileSync(SOURCE_FILE, "utf8").replace(/\r\n/g, "\n");

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

const NAMES = ["chomp", "readLines", "jqField", "consumeSurfaceMismatched"];
const DECLS = extract(NAMES);
const ERASED = ts.transpileModule(NAMES.map((n) => DECLS.get(n)).join("\n") + "\n", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true },
}).outputText;
const PROGRAM = `${ERASED}\n;({ consumeSurfaceMismatched });`;

const SPOOL = "/fake/state/dispatch/surface-mismatched.jsonl";

interface WhCall { args: string[]; out?: string }
interface Run { logs: string[]; wh: WhCall[]; removed: string[]; spoolPresent: boolean }
interface Opts {
  dryRun?: number;
  hostId?: string;
  readable?: boolean;
  /** The opt-in, exactly as the module-level constant computes it. */
  diagnosticOnly?: boolean;
  /** Status `wh focus` answers with, when the default arm calls it. */
  focusStatus?: number;
}

/**
 * Runs the real consumer over `lines` with a fake spool, a recording `wh` boundary and a
 * recording `log` sink. `lookup` answers with `hostId` so the host-id arm is actually
 * taken — a lookup that returned nothing could never prove whether focus was called.
 */
function run(lines: string[], opts: Opts = {}): Run {
  const dryRun = opts.dryRun ?? 0;
  const hostId = opts.hostId ?? "workspace:77";
  const readable = opts.readable ?? true;
  const diagnosticOnly = opts.diagnosticOnly ?? false;
  const focusStatus = opts.focusStatus ?? 0;
  const logs: string[] = [];
  const wh: WhCall[] = [];
  const removed: string[] = [];
  let present = readable;
  const fakeFs = {
    readFileSync(file: string): string {
      assert.equal(file, SPOOL, "the consumer must read its own spool and nothing else");
      if (!present) { const e: NodeJS.ErrnoException = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      // A here-string always appends one newline; readLines() drops that last empty part.
      return lines.map((l) => l + "\n").join("");
    },
    rmSync(file: string): void { removed.push(file); present = false; },
  };
  const decls = vm.runInContext(PROGRAM, vm.createContext({
    fs: fakeFs,
    SURFACE_MISMATCHED_SRC: SPOOL,
    SURFACE_MISMATCH_DIAGNOSTIC_ONLY: diagnosticOnly,
    DRY_RUN: dryRun,
    log: (msg: string) => { logs.push(msg); },
    wh: (args: string[], o?: { out?: string }) => {
      wh.push(o?.out === undefined ? { args: [...args] } : { args: [...args], out: o.out });
      if (args[0] === "lookup") return { status: 0, stdout: hostId + "\n" };
      if (args[0] === "focus") return { status: focusStatus, stdout: "" };
      // Any OTHER verb reaching this boundary is a regression: say so loudly rather than
      // answering it.
      throw new Error(`UNEXPECTED_WH_VERB: ${args.join(" ")}`);
    },
  }, { name: "extracted-reconciler-decls" })) as { consumeSurfaceMismatched: () => void };
  decls.consumeSurfaceMismatched();
  return { logs, wh, removed, spoolPresent: present };
}

const MISMATCH = JSON.stringify({
  sid: "fixture-stray", backend: "cmux", cmuxWorkspaceId: "workspace:77",
  expectedPtyPid: 4242, observedSurface: "ttys009", mismatchSeconds: 90,
});

// ── the DEFAULT arm: public behaviour, unchanged, on every adapter ─────────────────────
test("#616: with NO setting the consumer still resolves and focuses — the public behaviour", () => {
  const r = run([MISMATCH]);
  assert.deepEqual(r.wh.map((c) => c.args), [["lookup", "fixture-stray"], ["focus", "workspace:77"]],
    "the default arm must still look the host up and focus it, exactly as public main does");
  assert.equal(r.wh[1]!.out, "inherit", "the focus call must keep its inherited output");
  assert.deepEqual(r.logs, [
    "SURFACE_MISMATCHED refocused sid=fixture-stray host=workspace:77 expectedPty=4242",
    "surface_mismatched consumed=1",
  ]);
  assert.deepEqual(r.removed, [SPOOL]);
});

test("#616: with NO setting a non-zero focus is still reported as such", () => {
  const r = run([MISMATCH], { focusStatus: 1 });
  assert.deepEqual(r.logs, [
    "SURFACE_MISMATCHED refocus non-zero sid=fixture-stray host=workspace:77",
    "surface_mismatched consumed=1",
  ]);
});

test("#616: with NO setting an unresolvable sid still skips focus and still drains", () => {
  const r = run([MISMATCH], { hostId: "" });
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"], "no host id ⇒ nothing to focus");
  assert.deepEqual(r.logs, ["surface_mismatched consumed=1"]);
  assert.deepEqual(r.removed, [SPOOL]);
});

test("#616: with NO setting --dry-run still says would-refocus and reaches no adapter", () => {
  const r = run([MISMATCH], { dryRun: 1 });
  assert.deepEqual(r.wh, [], "a dry tick must not even look the host up");
  assert.deepEqual(r.logs, [
    "SURFACE_MISMATCHED would-refocus sid=fixture-stray expectedPty=4242",
    "surface_mismatched consumed=1",
  ]);
  assert.deepEqual(r.removed, [], "a dry tick must not drain the spool");
});

// ── the OPT-IN arm: diagnostic observation only ───────────────────────────────────────
test("#616/opt-in: a mismatch event actuates NO focus — only the read-only lookup crosses", () => {
  const r = run([MISMATCH], { diagnosticOnly: true });
  // The whole point: not one focus/select/raise call, on any adapter.
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"],
    "the only host-adapter call may be the read-only lookup");
  for (const call of r.wh) {
    for (const verb of ["focus", "select", "select-workspace", "raise", "activate"]) {
      assert.ok(!call.args.includes(verb), `focus actuation leaked in: ${call.args.join(" ")}`);
    }
  }
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=workspace:77 expectedPty=4242 /);
  assert.match(r.logs[0]!, /diagnostic only; no focus\/rebind actuation$/);
  assert.doesNotMatch(r.logs[0]!, /refocus/, "the log must not claim a refocus it did not do");
});

test("#616/opt-in: draining continues — the spool is removed and the count is still logged", () => {
  const r = run([MISMATCH, MISMATCH], { diagnosticOnly: true });
  assert.deepEqual(r.removed, [SPOOL],
    "the drain is unconditional: the bridge installs the next batch by rename onto an ABSENT path");
  assert.equal(r.spoolPresent, false);
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=2");
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup", "lookup"]);
});

test("#616/opt-in: an unresolvable sid is still recorded and still drained, with no actuation", () => {
  const r = run([MISMATCH], { diagnosticOnly: true, hostId: "" });
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"]);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=\? expectedPty=4242 /);
  assert.deepEqual(r.removed, [SPOOL]);
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
});

test("#616/opt-in: --dry-run reaches no host adapter at all, and leaves the spool in place", () => {
  const r = run([MISMATCH], { diagnosticOnly: true, dryRun: 1 });
  assert.deepEqual(r.wh, [], "a dry tick must not even look the host up");
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=\? expectedPty=4242 /);
  assert.deepEqual(r.removed, [], "a dry tick must not drain the spool");
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
});

// ── shared by both arms ───────────────────────────────────────────────────────────────
for (const diagnosticOnly of [false, true]) {
  const arm = diagnosticOnly ? "opt-in" : "default";
  test(`#616/${arm}: the consumer stays dormant and silent when no bridge has written a spool`, () => {
    const r = run([], { diagnosticOnly, readable: false });
    assert.deepEqual(r.logs, []);
    assert.deepEqual(r.wh, []);
    assert.deepEqual(r.removed, []);
  });

  test(`#616/${arm}: lines with no sid are skipped, not actuated, and never counted`, () => {
    const r = run(["", "not json at all", JSON.stringify({ expectedPtyPid: 7 }), MISMATCH], { diagnosticOnly });
    assert.equal(r.wh.filter((c) => c.args[0] === "lookup").length, 1,
      "only the one usable line reaches the lookup");
    assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
    assert.deepEqual(r.removed, [SPOOL], "unusable lines are still drained — they cannot wedge the spool");
  });
}

// ── source-level guards ───────────────────────────────────────────────────────────────
test("#616: the opt-in is a single exact-`1` read, defaulting to the public behaviour", () => {
  // The constant, not the consumer: a default-on spelling (`!== "0"`, `|| true`, a truthy
  // read) would make the opt-in the default, and it would pass every behavioural case
  // above because the fake binds the flag directly.
  const decl = /^const SURFACE_MISMATCH_DIAGNOSTIC_ONLY = .*$/m.exec(WHOLE)?.[0];
  assert.ok(decl, "SURFACE_MISMATCH_DIAGNOSTIC_ONLY must be a single-line module constant");
  assert.equal(decl, 'const SURFACE_MISMATCH_DIAGNOSTIC_ONLY = env.AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY === "1";',
    "the opt-in must be an exact match on \"1\", so absent/empty/anything else is the public behaviour");
  assert.equal(WHOLE.split("env.AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY").length - 1, 1,
    "the environment variable may be READ in exactly one place (prose mentions are fine)");
});

test("#616: the consumer's actuation is reachable only through the opt-in branch", () => {
  const decl = DECLS.get("consumeSurfaceMismatched")!;
  const verbs = [...decl.matchAll(/wh\(\s*\[\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(verbs, ["lookup", "focus"],
    `the consumer may call only lookup and focus, in that order, found: ${verbs.join(", ")}`);
  // Every `focus` call site must sit inside the `else` of the opt-in test, so the opted-in
  // arm cannot actuate: the only focus call must appear AFTER the flag's `if`.
  const flagAt = decl.indexOf("if (SURFACE_MISMATCH_DIAGNOSTIC_ONLY)");
  assert.ok(flagAt > 0, "the consumer must branch on the opt-in");
  assert.ok(decl.indexOf('wh(["focus"') > flagAt,
    "the focus call must be under the non-diagnostic branch of the opt-in");
  assert.ok(/\} else if \(hostId\) \{/.test(decl),
    "the public host-id gate must survive as the else-arm of the opt-in");
});
