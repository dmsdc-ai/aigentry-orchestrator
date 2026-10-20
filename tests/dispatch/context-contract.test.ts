import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDispatchInvocation, dispatchOptionArgs } from "../../src/environment/invocation.js";
import { dispatchMain, preflightDispatchContext, buildContextRefPrompt } from "../../src/dispatch/cli.js";
import { scopedReader, contextBindingArgs } from "../../src/task-context/assemble.js";
import { ContextRefusal, sha256, type ContextPorts } from "../../src/task-context/contract.js";

const hash = "a".repeat(64);
const args = ["--target", "sim-worker", "--task", "1163", "--ref", "/simulation/ref",
  "--context-manifest", "/simulation/manifest", "--context-sha256", hash];

test("real shared parser accepts complete pair and retains bootstrap context", () => {
  const parsed = parseDispatchInvocation([...args, "--cwd", "/simulation/project", "--role", "coder"]);
  assert.equal(parsed.values["--context-manifest"], "/simulation/manifest");
  assert.equal(parsed.values["--context-sha256"], hash);
  assert.equal(parsed.context.targetCwd, "/simulation/project");
  assert.equal(parsed.context.role, "coder");
  assert.deepEqual(parsed.observe, []);
});

test("pair validation preserves duplicate, unknown, value-token, help-tail and probe boundaries", () => {
  for (const argv of [
    ["--context-manifest", "/manifest"], ["--context-sha256", hash],
    [...args, "--context-manifest", "/second"], [...args, "--context-sha256", hash],
    ["--context-manifest", "--help"], ["--unknown", "value"],
    ["--context-manifest", "/manifest", "--context-sha256", "bad"],
  ]) assert.throws(() => parseDispatchInvocation(argv));
  assert.equal(parseDispatchInvocation(["--help", "--context-manifest"]).help, true);
  assert.equal(parseDispatchInvocation(["--context-manifest", "/manifest", "--help"]).help, true);
  assert.deepEqual(dispatchOptionArgs(["__probe", "screen-shows-delivery", "--context-manifest"]), []);
  const parsed = parseDispatchInvocation(["--ref", "literal-context-manifest", "--target", "sim-worker"]);
  assert.equal(preflightDispatchContext(parsed), null);
});

test("real dispatchMain strict refusal precedes initialization, file access and spawn", async () => {
  // No manufactured DispatchInvocation, process mock, transport or provider success.
  const parsed = parseDispatchInvocation(args);
  await assert.rejects(dispatchMain(parsed, undefined, { AIGENTRY_HOME: "\0invalid-must-never-be-used" }),
    (e: unknown) => e instanceof ContextRefusal && e.diagnostic.code === "source_cut_unverified");
});

test("simulated missing provider/registry ports refuse before controller file selection", () => {
  const authority: NonNullable<ContextPorts["authority"]> = {
    select: () => assert.fail("no source access before capacity/registry admission"),
    validateCut: () => assert.fail("no fabricated cut"),
  };
  assert.throws(() => preflightDispatchContext(parseDispatchInvocation(args), {
    authority, provider: null, registry: null,
  }), (e: unknown) => e instanceof ContextRefusal && e.diagnostic.code === "provider_budget_unknown");
  assert.throws(() => preflightDispatchContext(parseDispatchInvocation(args), {
    authority, provider: { capacity: { receipt: "sim", provider: "simulation", version: "1", available_bytes: 1 },
      admit: () => assert.fail("no provider call") }, registry: null,
  }), (e: unknown) => e instanceof ContextRefusal && e.diagnostic.code === "registry_context_unavailable");
});

test("scoped file reader hashes exact bytes, denies missing grants and detects changes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-source-test-")));
  try {
    const body = Buffer.from("원문\r\n"), file = path.join(root, "source");
    fs.writeFileSync(file, body, { mode: 0o600 });
    const grants = [{ logical_id: "source", root, relative: "source", revision: "1", sha256: sha256(body), bytes: body.length }];
    assert.throws(() => scopedReader(grants)("ungranted"), ContextRefusal);
    if (process.platform === "win32") {
      assert.throws(() => scopedReader(grants)("source"), (e: unknown) => e instanceof ContextRefusal && e.diagnostic.code === "source_denied");
    } else {
      assert.deepEqual(scopedReader(grants)("source"), body);
      fs.writeFileSync(file, Buffer.alloc(body.length, 65));
      assert.throws(() => scopedReader(grants)("source"), (e: unknown) => e instanceof ContextRefusal && e.diagnostic.code === "source_changed");
      fs.unlinkSync(file); fs.symlinkSync("missing", file);
      assert.throws(() => scopedReader(grants)("source"), ContextRefusal);
    }
    assert.throws(() => scopedReader([{ ...grants[0]!, relative: "../escape" }]), ContextRefusal);
    assert.throws(() => scopedReader([grants[0]!, { ...grants[0]!, logical_id: "other", relative: "SOURCE" }]), ContextRefusal);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pointer grammar stays exact and context binding is metadata-only proposed argv", () => {
  const file = "/sealed/home/.telepty/shared/abc.md";
  assert.equal(buildContextRefPrompt(file), `[context-ref] Read ${file} and use it as the source of truth for this task.`);
  const argv = contextBindingArgs({
    schema: "aigentry-context-binding/1", task_id: "1163", sid: "sim-worker", attempt: "sim-attempt",
    scope_sha256: hash, selection_revision: "sim-selection", source_cut: "sim-cut", cut_receipt: "sim-cut-receipt",
    generation: 0, parent_sha256: null, manifest_sha256: hash, body_sha256: hash, body_bytes: 10,
    original_ref_sha256: hash, final_ref_sha256: hash, provider_admission_receipt: "sim-gate", input_observation: "unobserved",
  });
  assert.equal(argv[0], "--context-binding");
  assert.equal(JSON.parse(argv[1]!).input_observation, "unobserved");
  assert.equal(Object.hasOwn(JSON.parse(argv[1]!), "path"), false);
});
