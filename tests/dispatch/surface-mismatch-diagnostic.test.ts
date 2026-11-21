// #507 / #616 — a surface_mismatched event is a DIAGNOSTIC OBSERVATION: the reconciler
// records it and drains the spool, and it must never actuate focus.
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
// the runner collects compiled tests on, win32 included.
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

const NAMES = ["chomp", "readLines", "jqField", "consumeSurfaceMismatched"];
const DECLS = extract(NAMES);
const ERASED = ts.transpileModule(NAMES.map((n) => DECLS.get(n)).join("\n") + "\n", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, isolatedModules: true },
}).outputText;
const PROGRAM = `${ERASED}\n;({ consumeSurfaceMismatched });`;

const SPOOL = "/fake/state/dispatch/surface-mismatched.jsonl";

interface WhCall { args: string[] }
interface Run { logs: string[]; wh: WhCall[]; removed: string[]; spoolPresent: boolean }

/**
 * Runs the real consumer over `lines` with a fake spool, a recording `wh` boundary and a
 * recording `log` sink. `lookup` answers with `hostId` so the host-id arm is actually
 * taken — a lookup that returned nothing could never prove that focus was NOT called.
 */
function run(lines: string[], opts: { dryRun?: number; hostId?: string; readable?: boolean } = {}): Run {
  const dryRun = opts.dryRun ?? 0;
  const hostId = opts.hostId ?? "workspace:77";
  const readable = opts.readable ?? true;
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
    DRY_RUN: dryRun,
    log: (msg: string) => { logs.push(msg); },
    wh: (args: string[]) => {
      wh.push({ args: [...args] });
      if (args[0] === "lookup") return { status: 0, stdout: hostId + "\n" };
      // Any OTHER verb reaching this boundary is the regression: say so loudly rather
      // than answering it.
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

test("#616: a mismatch event actuates NO focus — only a read-only lookup crosses the boundary", () => {
  const r = run([MISMATCH]);
  // The whole point: not one focus/select/raise call, on any adapter.
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"],
    "the only host-adapter call may be the read-only lookup");
  for (const call of r.wh) {
    for (const verb of ["focus", "select", "select-workspace", "raise", "activate"]) {
      assert.ok(!call.args.includes(verb), `focus actuation leaked back in: ${call.args.join(" ")}`);
    }
  }
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=workspace:77 expectedPty=4242 /);
  assert.match(r.logs[0]!, /diagnostic only; no focus\/rebind actuation$/);
  assert.doesNotMatch(r.logs[0]!, /refocus/, "the log must not claim a refocus it did not do");
});

test("#616: draining continues — the spool is removed and the consumed count is still logged", () => {
  const r = run([MISMATCH, MISMATCH]);
  assert.deepEqual(r.removed, [SPOOL],
    "the drain is unconditional: the bridge installs the next batch by rename onto an ABSENT path");
  assert.equal(r.spoolPresent, false);
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=2");
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup", "lookup"]);
});

test("#616: an unresolvable sid is still recorded and still drained, with no actuation", () => {
  const r = run([MISMATCH], { hostId: "" });
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"]);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=\? expectedPty=4242 /);
  assert.deepEqual(r.removed, [SPOOL]);
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
});

test("#616: --dry-run reaches no host adapter at all, and leaves the spool in place", () => {
  const r = run([MISMATCH], { dryRun: 1 });
  assert.deepEqual(r.wh, [], "a dry tick must not even look the host up");
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0]!, /^SURFACE_MISMATCHED unresolved sid=fixture-stray host=\? expectedPty=4242 /);
  assert.deepEqual(r.removed, [], "a dry tick must not drain the spool");
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
});

test("#616: the consumer stays dormant and silent when no bridge has written a spool", () => {
  const r = run([], { readable: false });
  assert.deepEqual(r.logs, []);
  assert.deepEqual(r.wh, []);
  assert.deepEqual(r.removed, []);
});

test("#616: lines with no sid are skipped, not actuated, and never counted", () => {
  const r = run(["", "not json at all", JSON.stringify({ expectedPtyPid: 7 }), MISMATCH]);
  assert.deepEqual(r.wh.map((c) => c.args[0]), ["lookup"], "only the one usable line reaches the lookup");
  assert.equal(r.logs.at(-1), "surface_mismatched consumed=1");
  assert.deepEqual(r.removed, [SPOOL], "unusable lines are still drained — they cannot wedge the spool");
});

test("#616: the production call site and the declaration agree that nothing is focused", () => {
  // A source-level guard: the only `wh([...])` call inside the extracted declaration is
  // the lookup. A future edit that reintroduces a focus call fails HERE as well as above.
  const decl = DECLS.get("consumeSurfaceMismatched")!;
  const verbs = [...decl.matchAll(/wh\(\s*\[\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(verbs, ["lookup"], `consumeSurfaceMismatched may only call wh lookup, found: ${verbs.join(", ")}`);
  assert.ok(!/wh_focus|"focus"/.test(decl), "no focus verb may appear in the consumer");
});
