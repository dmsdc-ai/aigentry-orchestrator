import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual private caller, without importing the CLI's live main().
// Only its process boundary is replaced; the child records the argv it receives.
const callers = [
  { label: "source", path: resolve(import.meta.dirname, "../../../src/dispatch/cli.ts") },
  // Test-only override proves stale compiled output fails; no product reads it.
  { label: "compiled", path: process.env.AIGENTRY_439_DIST_UNDER_TEST || resolve(import.meta.dirname, "../../src/dispatch/cli.js") },
];
for (const caller of callers) {
const source = readFileSync(caller.path, "utf8");
const parsed = ts.createSourceFile(caller.path, source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find((statement) =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "inject");
assert.ok(declaration, "production inject caller must exist");
const code = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const inline of [false, true]) {
  test(`${caller.label} dispatch explicitly disables force and retry: ${inline ? "confined inline" : "ref"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch439-"));
    try {
      const capture = join(root, "argv.json");
      const fixture = join(root, "telepty.cjs");
      writeFileSync(fixture, `require('node:fs').writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify({args:process.argv.slice(2),force:process.env.TELEPTY_SUBMIT_FORCE_DEFAULT}));`);
      const boundary = (command: string, args: readonly string[], options: SpawnOptions) => {
        assert.equal(command, "fixture-telepty-only");
        assert.ok(Array.isArray(args));
        return spawn(process.execPath, [fixture, ...args], {
          ...options,
          env: { ...process.env, TELEPTY_SUBMIT_FORCE_DEFAULT: "1", ARGV_CAPTURE: capture },
        });
      };
      const inject: unknown = runInNewContext(`${code}\ninject`, {
        TELEPTY: "fixture-telepty-only", spawn: boundary, crossSpawn: boundary,
        process, parseInjectId: () => "", rmTemp: () => assert.fail("unexpected temp removal"),
      });
      assert.ok(typeof inject === "function");
      const payload = "[context-ref] fixture request";
      assert.equal(await inject({ fromId: "fixture-controller" }, {
        refPrompt: inline ? payload : "", effRef: "fixture-ref.md", tmpRef: "",
      }, "fixture-worker"), 0);
      const observed: unknown = JSON.parse(readFileSync(capture, "utf8"));
      assert.deepEqual(observed, {
        force: "1",
        args: inline
          ? ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "fixture-controller", "fixture-worker", payload]
          : ["inject", "--ref", "fixture-ref.md", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "fixture-controller", "fixture-worker"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
}
