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

test("431-C — unknown --cli still rejected (#532 lifted claude-only gate to claude|codex|gemini)", () => {
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const r = runBootPrepare(home, ["--role", "coder", "--cwd", targetCwd, "--sid", "test-431-C", "--cli", "opencode"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unsupported --cli|unknown CLI|opencode/);
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

// ---------------------------------------------------------------------------
// #532 — codex / gemini additive role-injection (cwd context file + shadow home).
//
// boot-prepare stages the SAME effective_prompt.md (role layers + session
// contract) into the sandbox cwd under the CLI's auto-discovered context
// filename (codex AGENTS.md / gemini GEMINI.md) instead of a flag, and redirects
// the CLI config-home env to a per-session shadow home that symlink-mirrors the
// real home MINUS the global doc (so the per-user global AGENTS.md/GEMINI.md
// cannot leak) while PRESERVING auth (auth.json / oauth_creds.json).
//
// These spawn the real boot-prepare, which version-gates the actual CLI — skipped
// when the CLI binary is absent (CI). The config-home is pointed at a FAKE real
// home via env so no live ~/.codex / ~/.gemini is touched.
// ---------------------------------------------------------------------------

function cliAvailable(cli: string): boolean {
  const r = spawnSync(cli, ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

const CLI_MATRIX = [
  {
    cli: "codex",
    contextFile: "AGENTS.md",
    homeEnv: "CODEX_HOME",
    shadowDir: ".codexhome",
    authFile: "auth.json",
    settingsFile: "config.toml",
    globalCanary: "GLOBAL-CODEX-CANARY-532-must-not-leak",
    forbiddenFlags: ["--append-system-prompt-file", "--bare", "--permission-mode"],
    requiredFlags: ["-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"],
  },
  {
    cli: "gemini",
    contextFile: "GEMINI.md",
    homeEnv: "GEMINI_CLI_HOME",
    shadowDir: ".geminihome",
    authFile: "oauth_creds.json",
    settingsFile: "settings.json",
    globalCanary: "GLOBAL-GEMINI-CANARY-532-must-not-leak",
    forbiddenFlags: ["--append-system-prompt-file", "--bare", "--permission-mode"],
    requiredFlags: ["-m", "gemini-2.5-flash", "--approval-mode", "yolo", "--skip-trust"],
  },
] as const;

function setupFakeCliHome(root: string, m: typeof CLI_MATRIX[number]): string {
  const fakeReal = join(root, `real-${m.cli}`);
  mkdirSync(fakeReal, { recursive: true });
  writeFileSync(join(fakeReal, m.authFile), `{"token":"FAKE-${m.cli}-CREDENTIAL"}\n`);
  writeFileSync(join(fakeReal, m.settingsFile), `# fake ${m.cli} settings\n`);
  writeFileSync(join(fakeReal, m.contextFile), `# global ${m.cli} doc\n${m.globalCanary}\n`);
  return fakeReal;
}

function runBootPrepareEnv(
  home: string,
  extraEnv: Record<string, string>,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [BOOT_PREPARE, ...args], {
    env: { ...process.env, AIGENTRY_HOME: home, ...extraEnv },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

for (const m of CLI_MATRIX) {
  test(`532-${m.cli}-A — launcher execs ${m.cli} with real flags (NOT --append-system-prompt-file/--bare/--permission-mode)`, () => {
    if (!cliAvailable(m.cli)) { console.error(`532-${m.cli}-A SKIP — ${m.cli} not installed`); return; }
    const { home, targetCwd, cleanup } = setupTempHome();
    try {
      const fakeReal = setupFakeCliHome(home, m);
      const r = runBootPrepareEnv(home, { [m.homeEnv]: fakeReal },
        ["--role", "coder", "--cwd", targetCwd, "--sid", `t532-${m.cli}-A`, "--cli", m.cli]);
      assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
      const j = parseJson(r.stdout);
      const body = readFileSync(j.spawn_cli, "utf8");
      const execLine = body.split("\n").find((l) => /^\s*exec\b/.test(l));
      assert.ok(execLine, "launcher must contain an exec line");
      assert.match(execLine!, new RegExp(`exec\\s+-a\\s+${m.cli}\\s+${m.cli}\\b`), `must exec -a ${m.cli} ${m.cli}`);
      for (const f of m.requiredFlags) {
        assert.ok(execLine!.includes(f), `exec line must include ${f}; got: ${execLine}`);
      }
      // Forbidden flags must not be EXECUTED (the launcher comment may name them).
      for (const f of m.forbiddenFlags) {
        assert.ok(!execLine!.includes(f), `exec line must NOT contain ${f}; got: ${execLine}`);
      }
    } finally {
      cleanup();
    }
  });

  test(`532-${m.cli}-B — staged ${m.contextFile} in sandbox is byte-identical to effective_prompt.md (role + contract, no CLAUDE.md leak)`, () => {
    if (!cliAvailable(m.cli)) { console.error(`532-${m.cli}-B SKIP — ${m.cli} not installed`); return; }
    const { home, targetCwd, cleanup } = setupTempHome();
    try {
      const fakeReal = setupFakeCliHome(home, m);
      const r = runBootPrepareEnv(home, { [m.homeEnv]: fakeReal },
        ["--role", "coder", "--cwd", targetCwd, "--sid", `t532-${m.cli}-B`, "--cli", m.cli]);
      assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
      const j = parseJson(r.stdout);
      const staged = join(j.spawn_cwd, m.contextFile);
      assert.ok(existsSync(staged), `staged ${m.contextFile} must exist in sandbox`);
      const stagedBytes = readFileSync(staged);
      const effective = readFileSync(join(home, "sessions", `t532-${m.cli}-B`, "boot", "effective_prompt.md"));
      assert.deepEqual(stagedBytes, effective, "staged context file must byte-match effective_prompt.md");
      const content = stagedBytes.toString("utf8");
      assert.match(content, /MARKER-CODER-431-allowed/, "role layer present");
      assert.match(content, /Session boot contract/, "session contract present");
      assert.doesNotMatch(content, /MARKER-FORBIDDEN-431-must-not-leak/, "project CLAUDE.md must not leak");
      assert.doesNotMatch(content, new RegExp(m.globalCanary), "global doc must not leak into staged prompt");
    } finally {
      cleanup();
    }
  });

  test(`532-${m.cli}-C — launcher exports ${m.homeEnv} shadow home + AIGENTRY_TARGET_CWD`, () => {
    if (!cliAvailable(m.cli)) { console.error(`532-${m.cli}-C SKIP — ${m.cli} not installed`); return; }
    const { home, targetCwd, cleanup } = setupTempHome();
    try {
      const fakeReal = setupFakeCliHome(home, m);
      const r = runBootPrepareEnv(home, { [m.homeEnv]: fakeReal },
        ["--role", "coder", "--cwd", targetCwd, "--sid", `t532-${m.cli}-C`, "--cli", m.cli]);
      assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
      const j = parseJson(r.stdout);
      const body = readFileSync(j.spawn_cli, "utf8");
      const shadow = join(j.spawn_cwd, m.shadowDir);
      assert.match(body, new RegExp(`export ${m.homeEnv}=.{0,2}${shadow.replace(/[.\\()[\]]/g, ".")}`),
        `launcher must export ${m.homeEnv}=${shadow}`);
      assert.match(body, /export AIGENTRY_TARGET_CWD=/);
      assert.equal(j.env.AIGENTRY_TARGET_CWD, targetCwd);
    } finally {
      cleanup();
    }
  });

  test(`532-${m.cli}-D — shadow home mirrors auth + settings but OMITS the global ${m.contextFile}`, () => {
    if (!cliAvailable(m.cli)) { console.error(`532-${m.cli}-D SKIP — ${m.cli} not installed`); return; }
    const { home, targetCwd, cleanup } = setupTempHome();
    try {
      const fakeReal = setupFakeCliHome(home, m);
      const r = runBootPrepareEnv(home, { [m.homeEnv]: fakeReal },
        ["--role", "coder", "--cwd", targetCwd, "--sid", `t532-${m.cli}-D`, "--cli", m.cli]);
      assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
      const j = parseJson(r.stdout);
      const shadow = join(j.spawn_cwd, m.shadowDir);
      assert.ok(existsSync(shadow), "shadow home must exist");
      // Auth preserved (symlink resolves to fake credential).
      assert.ok(existsSync(join(shadow, m.authFile)), `auth (${m.authFile}) must be mirrored`);
      assert.match(readFileSync(join(shadow, m.authFile), "utf8"), /FAKE-.*-CREDENTIAL/,
        "auth mirror must resolve to real credential (symlink)");
      // Settings preserved.
      assert.ok(existsSync(join(shadow, m.settingsFile)), `settings (${m.settingsFile}) must be mirrored`);
      // Global doc OMITTED → no leak.
      assert.equal(existsSync(join(shadow, m.contextFile)), false,
        `global ${m.contextFile} must be OMITTED from shadow home`);
      // Entry is a symlink (mirror, not copy).
      assert.ok(statSync(join(shadow, m.authFile)).isFile(), "auth entry resolves");
    } finally {
      cleanup();
    }
  });
}

test("551-gemini — AIGENTRY_GEMINI_MODEL overrides boot-prep launcher model", () => {
  if (!cliAvailable("gemini")) { console.error("551-gemini SKIP — gemini not installed"); return; }
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const gemini = CLI_MATRIX.find((m) => m.cli === "gemini")!;
    const fakeReal = setupFakeCliHome(home, gemini);
    const r = runBootPrepareEnv(home, {
      GEMINI_CLI_HOME: fakeReal,
      AIGENTRY_GEMINI_MODEL: "gemini-test-override",
    }, ["--role", "coder", "--cwd", targetCwd, "--sid", "t551-gemini", "--cli", "gemini"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const execLine = readFileSync(j.spawn_cli, "utf8")
      .split("\n")
      .find((l) => /^\s*exec\b/.test(l));
    assert.ok(execLine, "launcher must contain an exec line");
    assert.match(execLine!, /-m gemini-test-override\b/);
  } finally {
    cleanup();
  }
});
