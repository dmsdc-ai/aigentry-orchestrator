// T142 (#1069) — bin/install-instructions.sh must substitute the init template tokens
// itself, and must fail loudly, naming the files, when any "{{" survives in the tree it owns.
//
// Measured 2026-08-30 / re-measured 2026-09-05: the script was a bare `cp` and substitution
// lived only on the `init` path (bin/init/cli.mjs step 6). So `--force` from a git checkout
// over an init'd ~/.aigentry restored `{{CONSTITUTION_PATH}}` (common.md ×2) and
// `{{CONTROL_WORKSPACE}}` (roles/orchestrator.md) — and the fresh-home route that
// bin/boot-prepare.mjs takes (no --force) leaked the same two files. The second damaged file
// was found only by sweeping the tree for the token, not by checking the edited file.
//
// Throwaway AIGENTRY_HOME only — never the live ~/.aigentry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "bin", "install-instructions.sh");

function run(home: string, ...args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, AIGENTRY_HOME: home },
  });
}

/** Every file the script owns: common.md + roles/*.md. projects/ is user content. */
function ownedFiles(home: string): string[] {
  const root = join(home, "instructions");
  const roles = join(root, "roles");
  return [join(root, "common.md"), ...readdirSync(roles).map((f) => join(roles, f))];
}

function filesWithBraces(home: string): string[] {
  return ownedFiles(home).filter((f) => readFileSync(f, "utf8").includes("{{"));
}

function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "t142-install-tokens-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("T142a fresh install from a raw checkout substitutes the init tokens via the shared map", async () => {
  const { home, cleanup } = tempHome();
  try {
    const r = run(home);
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
    assert.deepEqual(filesWithBraces(home), [], "no {{ may survive in the owned surface");

    // The values come from ONE place — bin/init/manifest.mjs — and are the ones init writes.
    const common = readFileSync(join(home, "instructions", "common.md"), "utf8");
    assert.ok(common.includes(`\`${join(home, "CONSTITUTION.md")}\``), "CONSTITUTION_PATH → $AIGENTRY_HOME/CONSTITUTION.md");
    const orch = readFileSync(join(home, "instructions", "roles", "orchestrator.md"), "utf8");
    assert.ok(orch.includes(`python3 ${REPO_ROOT}/bin/session-layout.py`), "CONTROL_WORKSPACE → the checkout that owns bin/");

    const manifest = await import(pathToFileURL(join(REPO_ROOT, "bin", "init", "manifest.mjs")).href);
    assert.deepEqual(
      Object.keys(manifest.templateSubs(REPO_ROOT, home)),
      manifest.TEMPLATE_TOKENS,
      "templateSubs must value exactly TEMPLATE_TOKENS — the list and the map live together",
    );
  } finally {
    cleanup();
  }
});

test("T142b --force over an already-substituted tree leaves 0 tokens", () => {
  const { home, cleanup } = tempHome();
  try {
    assert.equal(run(home).status, 0);
    assert.deepEqual(filesWithBraces(home), []);

    const r = run(home, "--force");
    assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /^updated file: .*\/roles\/orchestrator\.md$/m, "--force must actually rewrite");
    assert.deepEqual(filesWithBraces(home), [], "the #1069 regression: --force restored raw tokens");
  } finally {
    cleanup();
  }
});

test("T142c a surviving token in a preserved file fails the install, naming the file", () => {
  const { home, cleanup } = tempHome();
  try {
    assert.equal(run(home).status, 0);
    const planted = join(home, "instructions", "roles", "coder.md");
    appendFileSync(planted, "\n{{CONSTITUTION_PATH}}\n");

    // No --force: coder.md is preserved (never rewritten), so only the sweep can catch it.
    const r = run(home);
    assert.equal(r.status, 4, `expected exit 4, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /unsubstituted template token/);
    assert.ok(r.stderr.includes(planted), `stderr must name the file:\n${r.stderr}`);
    assert.ok(!r.stderr.includes("common.md"), "and only the damaged file");
  } finally {
    cleanup();
  }
});
