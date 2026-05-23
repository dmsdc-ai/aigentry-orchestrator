// #431 (ADR 2026-05-12 hybrid (b-2)+(c)) — bin/boot-prepare.mjs wiring contract test.
//
// Demonstrates the full hybrid: per-session launcher.sh wrapper sets
// AIGENTRY_TARGET_CWD env and execs `claude --append-system-prompt-file <staged>`
// (OAuth-compatible, NOT --bare). Spawn cwd is a clean sandbox so no project
// CLAUDE.md auto-discovery contaminates the worker. Decoy CLAUDE.md MARKER
// in a fake "target cwd" must never reach the staged effective_prompt.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT_PREPARE = join(REPO_ROOT, "bin", "boot-prepare.mjs");

interface BootJson {
  spawn_cli: string;
  extra_flags: string;
  spawn_cwd: string;
  env: Record<string, string>;
}

function setupTempHome(): { home: string; targetCwd: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "boot-prepare-431-"));
  const home = join(root, "aig");
  const targetCwd = join(root, "cwd-with-claudemd");
  mkdirSync(join(home, "instructions", "roles"), { recursive: true });
  mkdirSync(join(home, "instructions", "projects"), { recursive: true });
  mkdirSync(targetCwd, { recursive: true });
  writeFileSync(
    join(home, "instructions", "common.md"),
    "# COMMON\nMARKER-COMMON-431-allowed\n",
  );
  writeFileSync(
    join(home, "instructions", "roles", "coder.md"),
    "# Role: coder\nMARKER-CODER-431-allowed\n",
  );
  writeFileSync(
    join(targetCwd, "CLAUDE.md"),
    "# Orchestrator CLAUDE.md\nMARKER-FORBIDDEN-431-must-not-leak\n",
  );
  return {
    home,
    targetCwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runBootPrepare(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [BOOT_PREPARE, ...args], {
    env: { ...process.env, AIGENTRY_HOME: home },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function parseJson(stdout: string): BootJson {
  return JSON.parse(stdout.trim());
}

test("431-A — JSON output exposes an executable launcher.sh as spawn_cli", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-A"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    assert.match(j.spawn_cli, /launcher\.sh$/);
    assert.ok(existsSync(j.spawn_cli));
    // Mode bits: owner-executable.
    assert.equal(statSync(j.spawn_cli).mode & 0o100, 0o100);
    // extra_flags is empty — launcher encodes everything.
    assert.equal(j.extra_flags.trim(), "");
  } finally {
    cleanup();
  }
});

test("431-B — launcher.sh execs claude with --append-system-prompt-file (NOT --bare)", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-B"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const body = readFileSync(j.spawn_cli, "utf8");
    assert.match(body, /exec\b.*\bclaude\b/, "must exec claude");
    assert.match(body, /--append-system-prompt-file\b/, "must use OAuth-compatible flag");
    assert.doesNotMatch(body, /--bare\b/, "must NOT use --bare (OAuth-incompatible)");
    assert.match(body, /--permission-mode bypassPermissions\b/);
  } finally {
    cleanup();
  }
});

test("431-B.1 — staged effective_prompt.md carries role layer, never target-cwd CLAUDE.md", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-B1"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const body = readFileSync(j.spawn_cli, "utf8");
    // Restrict to the exec line — `# ... --append-system-prompt-file pointing ...`
    // comment string would otherwise match first.
    const execLine = body.split("\n").find((l) => /^\s*exec\b/.test(l));
    assert.ok(execLine, "launcher.sh must contain an `exec` line");
    const m = execLine!.match(/--append-system-prompt-file\s+'?([^'\s]+)'?/);
    assert.ok(m, "launcher must expose --append-system-prompt-file path");
    const promptPath = m![1];
    const content = readFileSync(promptPath, "utf8");
    assert.match(content, /MARKER-COMMON-431-allowed/);
    assert.match(content, /MARKER-CODER-431-allowed/);
    assert.doesNotMatch(
      content,
      /MARKER-FORBIDDEN-431-must-not-leak/,
      "target-cwd CLAUDE.md must never reach effective_prompt (ADR §3, §V4a)",
    );
  } finally {
    cleanup();
  }
});

test("431-F — launcher.sh exports AIGENTRY_TARGET_CWD = caller's --cwd", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-F"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    assert.equal(j.env.AIGENTRY_TARGET_CWD, targetCwd, "JSON env must mirror target cwd");
    const body = readFileSync(j.spawn_cli, "utf8");
    assert.match(
      body,
      new RegExp(`export AIGENTRY_TARGET_CWD=.{0,2}${targetCwd.replace(/[\.\\\(\)\[\]]/g, ".")}`),
      "launcher.sh must export AIGENTRY_TARGET_CWD with the target cwd value",
    );
  } finally {
    cleanup();
  }
});

test("431-G — spawn_cwd is under role-sandbox, exists, has no CLAUDE.md", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-G"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    assert.match(j.spawn_cwd, /\/role-sandbox\/coder-test-431-G$/);
    assert.ok(existsSync(j.spawn_cwd));
    assert.equal(
      existsSync(join(j.spawn_cwd, "CLAUDE.md")),
      false,
      "sandbox must not contain CLAUDE.md (auto-discovery defense)",
    );
  } finally {
    cleanup();
  }
});

test("431-H — effective_prompt.md appends the session contract preamble", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-H"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const body = readFileSync(j.spawn_cli, "utf8");
    const execLine = body.split("\n").find((l) => /^\s*exec\b/.test(l))!;
    const promptPath = execLine.match(/--append-system-prompt-file\s+'?([^'\s]+)'?/)![1];
    const content = readFileSync(promptPath, "utf8");
    assert.match(content, /Session boot contract \(#431/);
    assert.match(content, new RegExp(`AIGENTRY_TARGET_CWD.*${targetCwd.replace(/[\.\\\(\)\[\]]/g, ".")}`));
    assert.match(content, new RegExp(`Sandbox cwd.*${j.spawn_cwd.replace(/[\.\\\(\)\[\]]/g, ".")}`));
  } finally {
    cleanup();
  }
});

test("431-C — codex/gemini rejected at this dispatch (UPSTREAM-GAP deferred)", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    for (const cli of ["codex", "gemini"] as const) {
      const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-C", "--cli", cli]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /only --cli claude supported/);
    }
  } finally {
    cleanup();
  }
});

test("431-D — unknown role rejected with non-zero", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "wizard", "--cwd", targetCwd, "--sid", "test-431-D"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown role|ERR_ROLE_UNKNOWN/);
  } finally {
    cleanup();
  }
});

test("431-E — missing required arg surfaces usage exit (4)", () => {
  const r = spawnSync("node", [BOOT_PREPARE, "--role", "coder"], { encoding: "utf8" });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /--cwd required/);
});
