// #1070 — `npm test` must refuse, by name, compiled tests whose source was deleted.
// tsc never removes stale output, so dist/tests/x.test.js outlives tests/x.test.ts and keeps
// running (measured: a deleted test kept the count at 262 until dist/ was removed).
// The stub tree lives in os.tmpdir(), never in the real dist/, so this test cannot itself
// become the orphan it guards against.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const guard = (await import(
  pathToFileURL(path.resolve("scripts/stale-dist-guard.mjs")).href
)) as { findStaleCompiled(repoRoot: string): string[] };

function stubRepo(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mr1070-stale-"));
  for (const rel of files) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
  }
  return root;
}

test("1070: every orphan under dist/tests is named — tests and helpers alike", () => {
  const root = stubRepo([
    "tests/session/kept.test.ts",
    "tests/session/helper.ts",
    "dist/tests/session/kept.test.js",
    "dist/tests/session/kept.test.d.ts",
    "dist/tests/session/kept.test.js.map",
    "dist/tests/session/helper.js",
    "dist/tests/session/gone.test.js",
    "dist/tests/session/gone.test.d.ts",
    "dist/tests/fixtures/lost.js",
  ]);
  assert.deepEqual(guard.findStaleCompiled(root), [
    "stale compiled helper: dist/tests/fixtures/lost.js (no tests/fixtures/lost.ts source)",
    "stale compiled test: dist/tests/session/gone.test.js (no tests/session/gone.test.ts source)",
  ]);
});

test("1070: a clean tree reports nothing", () => {
  const root = stubRepo([
    "tests/session/kept.test.ts",
    "dist/tests/session/kept.test.js",
    "dist/tests/session/kept.test.d.ts",
  ]);
  assert.deepEqual(guard.findStaleCompiled(root), []);
});

test("1070: no dist/tests at all is not stale (the runner reports the missing build itself)", () => {
  const root = stubRepo(["tests/session/kept.test.ts"]);
  assert.deepEqual(guard.findStaleCompiled(root), []);
});
