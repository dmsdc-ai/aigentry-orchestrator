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
  lstatSync,
  realpathSync,
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
    // #569: CODEX_HOME IS the config dir directly → no subdir, auth stays a symlink.
    configSubdir: "",
    authDesymlinked: false,
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
    // #569: GEMINI_CLI_HOME is the HOME; gemini reads creds from `$HOME/.gemini`.
    // The writable OAuth creds are de-symlinked (real 0600 copy) so a token
    // refresh write stays sandboxed instead of mutating the real ~/.gemini.
    configSubdir: ".gemini",
    authDesymlinked: true,
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
      // #569: the CLI's config dir may be a SUBDIR of the home env (gemini
      // `.gemini`); codex keeps the home as its config dir (configSubdir === "").
      const shadowCfg = m.configSubdir ? join(shadow, m.configSubdir) : shadow;
      // Auth present + carrying the real credential (symlink for codex; 0600 copy
      // for gemini — either way the credential bytes are reachable).
      assert.ok(existsSync(join(shadowCfg, m.authFile)), `auth (${m.authFile}) must be mirrored`);
      assert.match(readFileSync(join(shadowCfg, m.authFile), "utf8"), /FAKE-.*-CREDENTIAL/,
        "auth mirror must carry the real credential");
      // Settings preserved.
      assert.ok(existsSync(join(shadowCfg, m.settingsFile)), `settings (${m.settingsFile}) must be mirrored`);
      // Global doc OMITTED → no leak.
      assert.equal(existsSync(join(shadowCfg, m.contextFile)), false,
        `global ${m.contextFile} must be OMITTED from shadow home`);
      // Entry resolves to a regular file.
      assert.ok(statSync(join(shadowCfg, m.authFile)).isFile(), "auth entry resolves");
      // #569: writable creds are de-symlinked (real copy) for gemini so a token
      // refresh cannot follow the link and mutate the real home; codex auth stays
      // a symlink (codex creds are not written through the shadow here).
      assert.equal(lstatSync(join(shadowCfg, m.authFile)).isSymbolicLink(), !m.authDesymlinked,
        `auth ${m.authDesymlinked ? "must be de-symlinked (real copy)" : "stays a symlink"}`);
    } finally {
      cleanup();
    }
  });
}

// #552 — codex pre-trust: the shadow config.toml must carry the sandbox cwd as a
// trusted project (codex's own on-disk schema) so codex skips its blocking
// folder-trust modal at boot, while the real ~/.codex/config.toml stays untouched
// (credential/config boundary — we de-symlink, never write through the link).
test("552-codex-E — shadow config.toml pre-trusts the sandbox cwd; real config untouched", () => {
  if (!cliAvailable("codex")) { console.error("552-codex-E SKIP — codex not installed"); return; }
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const codex = CLI_MATRIX.find((m) => m.cli === "codex")!;
    const fakeReal = setupFakeCliHome(home, codex);
    const realConfig = join(fakeReal, "config.toml");
    const realBefore = readFileSync(realConfig, "utf8");
    const r = runBootPrepareEnv(home, { CODEX_HOME: fakeReal },
      ["--role", "coder", "--cwd", targetCwd, "--sid", "t552-codex-E", "--cli", "codex"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const shadowConfig = join(j.spawn_cwd, codex.shadowDir, "config.toml");
    assert.ok(existsSync(shadowConfig), "shadow config.toml must exist");
    const shadowText = readFileSync(shadowConfig, "utf8");
    // Trust entry for the CANONICAL sandbox cwd (codex keys trust on getcwd(),
    // symlinks collapsed — e.g. macOS tmp /var → /private/var), in codex's
    // `[projects."<abspath>"]` + trust_level = "trusted" on-disk schema.
    const canonicalCwd = realpathSync(j.spawn_cwd);
    assert.ok(
      shadowText.includes(`[projects."${canonicalCwd}"]`),
      `shadow config must declare [projects."${canonicalCwd}"]; got:\n${shadowText}`,
    );
    assert.match(shadowText, /trust_level\s*=\s*"trusted"/, "must set trust_level = trusted");
    // Real config contents preserved in the shadow copy (settings not dropped).
    assert.match(shadowText, /fake codex settings/, "shadow must preserve real config contents");
    // Shadow config is a REAL file, not a symlink into the real home — else the
    // write would have mutated ~/.codex/config.toml.
    assert.equal(lstatSync(shadowConfig).isSymbolicLink(), false,
      "shadow config.toml must be de-symlinked (real file), not a link to the real home");
    // The real config.toml must be byte-identical (boundary: never written through).
    assert.equal(readFileSync(realConfig, "utf8"), realBefore,
      "real config.toml must NOT be modified");
  } finally {
    cleanup();
  }
});

// #569 — gemini shadow-home auth. GEMINI_CLI_HOME is gemini's HOME, not its
// config dir: gemini reads creds from `$GEMINI_CLI_HOME/.gemini/`
// (Storage.getGlobalGeminiDir()). The pre-#569 flat mirror put creds at
// `$GEMINI_CLI_HOME/` top-level, so gemini found none and fell through to its
// auth-selector (never reached the REPL). The shadow must mirror under the
// `.gemini` subdir, and the writable OAuth creds must be de-symlinked (real 0600
// copy) so a token-refresh write stays sandboxed and never mutates real ~/.gemini.
test("569-gemini-A — creds mirror lands under the .gemini subdir, NOT the home top-level", () => {
  if (!cliAvailable("gemini")) { console.error("569-gemini-A SKIP — gemini not installed"); return; }
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const gemini = CLI_MATRIX.find((m) => m.cli === "gemini")!;
    const fakeReal = setupFakeCliHome(home, gemini);
    const r = runBootPrepareEnv(home, { GEMINI_CLI_HOME: fakeReal },
      ["--role", "coder", "--cwd", targetCwd, "--sid", "t569-gemini-A", "--cli", "gemini"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const homeShadow = join(j.spawn_cwd, gemini.shadowDir);
    const cfgShadow = join(homeShadow, ".gemini");
    // The config dir gemini actually reads (`$GEMINI_CLI_HOME/.gemini`) holds creds.
    assert.ok(existsSync(join(cfgShadow, "oauth_creds.json")),
      "creds must live under the .gemini subdir gemini reads (getGlobalGeminiDir)");
    assert.ok(existsSync(join(cfgShadow, "settings.json")), "settings under .gemini");
    // The home top-level must NOT hold the creds (that was the #569 bug layout).
    assert.equal(existsSync(join(homeShadow, "oauth_creds.json")), false,
      "creds must NOT be at the home top-level (pre-#569 bug layout)");
    // GEMINI_CLI_HOME is exported as the HOME (parent of .gemini), not the cfg dir.
    const body = readFileSync(j.spawn_cli, "utf8");
    assert.match(body, new RegExp(`export GEMINI_CLI_HOME=.{0,2}${homeShadow.replace(/[.\\()[\]]/g, ".")}\\b`),
      "GEMINI_CLI_HOME must point at the home (parent of .gemini)");
  } finally {
    cleanup();
  }
});

test("569-gemini-B — writable creds de-symlinked (0600 copy); real ~/.gemini byte-identical", () => {
  if (!cliAvailable("gemini")) { console.error("569-gemini-B SKIP — gemini not installed"); return; }
  const { home, targetCwd, cleanup } = setupTempHome();
  try {
    const gemini = CLI_MATRIX.find((m) => m.cli === "gemini")!;
    const fakeReal = setupFakeCliHome(home, gemini);
    // Seed google_accounts.json too — gemini writes it on auth; it must also be
    // de-symlinked so the write cannot follow the link into the real home.
    writeFileSync(join(fakeReal, "google_accounts.json"), `{"active":"FAKE@example.com","old":[]}\n`);
    const realOauthBefore = readFileSync(join(fakeReal, "oauth_creds.json"));
    const realAcctBefore = readFileSync(join(fakeReal, "google_accounts.json"));
    const r = runBootPrepareEnv(home, { GEMINI_CLI_HOME: fakeReal },
      ["--role", "coder", "--cwd", targetCwd, "--sid", "t569-gemini-B", "--cli", "gemini"]);
    assert.equal(r.code, 0, `exit ${r.code} stderr=${r.stderr}`);
    const j = parseJson(r.stdout);
    const cfgShadow = join(j.spawn_cwd, gemini.shadowDir, ".gemini");
    for (const credFile of ["oauth_creds.json", "google_accounts.json"]) {
      const shadowFile = join(cfgShadow, credFile);
      assert.ok(existsSync(shadowFile), `${credFile} present in shadow .gemini`);
      // De-symlinked: a real file, not a link into the real home (else a refresh
      // write would follow the link and overwrite the real credential).
      assert.equal(lstatSync(shadowFile).isSymbolicLink(), false,
        `${credFile} must be a real copy, not a symlink into the real home`);
      // Owner-only perms (0600) on the cred copy.
      assert.equal(statSync(shadowFile).mode & 0o777, 0o600, `${credFile} copy must be mode 0600`);
    }
    // The copy carries the real credential content (so auth still works).
    assert.match(readFileSync(join(cfgShadow, "oauth_creds.json"), "utf8"), /FAKE-.*-CREDENTIAL/);
    // Boundary: the real (fake) ~/.gemini creds are byte-identical — never written.
    assert.deepEqual(readFileSync(join(fakeReal, "oauth_creds.json")), realOauthBefore,
      "real oauth_creds.json must NOT be modified");
    assert.deepEqual(readFileSync(join(fakeReal, "google_accounts.json")), realAcctBefore,
      "real google_accounts.json must NOT be modified");
  } finally {
    cleanup();
  }
});

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
