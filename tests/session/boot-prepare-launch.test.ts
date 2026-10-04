// #1162 G2a-T — bin/boot-prepare.mjs stdout `launch` (LaunchConfig v2) vs the
// final argv/launcher it actually emits. Hermetic: fake CLI shims only (no real
// CLI), fake HOME / AIGENTRY_HOME, PATH = shim dir only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT_PREPARE = join(REPO_ROOT, "bin", "boot-prepare.mjs");
const SHIMS = ["claude", "codex", "gemini", "agy", "grok"];
const UNKNOWN = { value: "unknown", source: "unknown" };
const CLI_DEF = { value: "unknown", source: "cli-default" };

interface Out {
  argv: string[]; spawn_cli: string; extra_flags: string; spawn_cwd: string;
  env: Record<string, string>; launch: unknown;
}

function fixture(): { root: string; home: string; target: string; env: (x?: Record<string, string>) => NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "bp-1162-"));
  const home = join(root, "aig");
  const target = join(root, "target");
  const bin = join(root, "shimbin");
  mkdirSync(bin, { recursive: true });
  for (const cli of SHIMS) {
    writeFileSync(join(bin, cli),
      `#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (shim)" ;; --help) echo "--model --dangerously-skip-permissions --prompt-interactive" ;; esac\nexit 0\n`,
      { mode: 0o755 });
  }
  for (const d of ["fakehome", "real-codex", "real-gemini"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "fakehome", ".claude.json"), "{}\n");
  mkdirSync(join(home, "instructions", "roles"), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(home, "instructions", "common.md"), "# COMMON\n");
  writeFileSync(join(home, "instructions", "roles", "coder.md"), "# Role: coder\n");
  const env = (x: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: bin, HOME: join(root, "fakehome"), USERPROFILE: join(root, "fakehome"), TMPDIR: tmpdir(), AIGENTRY_HOME: home,
    CODEX_HOME: join(root, "real-codex"), GEMINI_CLI_HOME: join(root, "real-gemini"), ...x,
  });
  return { root, home, target, env };
}

function run(cli: string, extra: Record<string, string> = {}, sid = `t1162-${cli}`): { out: Out; launcher: string; stagingFiles: string[] } {
  const f = fixture();
  try {
    const binary = cli === "agy" ? "agy" : "gemini";
    const r = spawnSync(process.execPath,
      [BOOT_PREPARE, "--role", "coder", "--cwd", f.target, "--sid", sid, "--cli", cli === "agy" ? "gemini" : cli],
      { env: f.env({ AIGENTRY_GEMINI_BINARY: binary, ...extra }), encoding: "utf8" });
    assert.equal(r.status, 0, `exit ${r.status} stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout.trim()) as Out;
    return {
      out,
      launcher: readFileSync(out.spawn_cli, "utf8"),
      stagingFiles: readdirSync(join(f.home, "sessions", sid, "boot")).sort(),
    };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

const execLine = (body: string) => body.split("\n").find((l) => /^\s*exec\b/.test(l)) ?? "";
function noDup(argv: readonly string[]): void {
  for (const f of ["--model", "-m", "--effort", "--reasoning-effort", "--permission-mode", "--append-system-prompt-file"]) {
    assert.ok(argv.filter((a) => a === f).length <= 1, `duplicate ${f}: ${JSON.stringify(argv)}`);
  }
}

test("BP0 fixture home stays local in child process", () => {
  const f = fixture();
  try {
    const fakehome = join(f.root, "fakehome");
    const env = f.env();
    // Checked before any child runs: dropping USERPROFILE (win32 homedir source) fails here, not via host fallback.
    assert.equal(env.HOME, fakehome);
    assert.equal(env.USERPROFILE, fakehome);
    for (const k of ["CODEX_HOME", "GEMINI_CLI_HOME"]) {
      assert.ok(env[k]?.startsWith(f.root + sep), `${k}=${env[k]} not under fixture root`);
    }
    const r = spawnSync(process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ home: require(\"node:os\").homedir() }))"],
      { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, `exit ${r.status} signal=${r.signal} stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { home: fakehome });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("BP1 claude final argv: exact order, no duplicate flags, launch default/default", () => {
  const { out, launcher, stagingFiles } = run("claude");
  const p = out.argv[2]!;
  assert.deepEqual(out.argv, ["claude", "--append-system-prompt-file", p,
    "--model", "claude-opus-5", "--effort", "xhigh", "--permission-mode", "bypassPermissions"]);
  noDup(out.argv);
  assert.deepEqual(out.launch, { v: 2, cli: "claude",
    model: { value: "claude-opus-5", source: "default" }, effort: { value: "xhigh", source: "default" } });
  assert.match(execLine(launcher), / --model claude-opus-5 --effort xhigh --permission-mode bypassPermissions "\$@"$/);
  assert.deepEqual(Object.keys(out), ["argv", "spawn_cli", "extra_flags", "spawn_cwd", "env", "launch"]);
  assert.equal(out.extra_flags, "");
  assert.ok(!stagingFiles.includes("launch.json"), "no launch.json state write");
});

test("BP2 claude configured env reaches argv once and launch as env:<NAME>", () => {
  const { out } = run("claude", { AIGENTRY_CLAUDE_MODEL: "claude-sonnet-5", AIGENTRY_CLAUDE_EFFORT: "low" });
  assert.deepEqual(out.argv.slice(3), ["--model", "claude-sonnet-5", "--effort", "low", "--permission-mode", "bypassPermissions"]);
  assert.deepEqual(out.launch, { v: 2, cli: "claude",
    model: { value: "claude-sonnet-5", source: "env:AIGENTRY_CLAUDE_MODEL" },
    effort: { value: "low", source: "env:AIGENTRY_CLAUDE_EFFORT" } });
});

test("BP3 invalid label: argv/launcher keep raw value, launch reports unknown", () => {
  const { out, launcher } = run("claude", { AIGENTRY_CLAUDE_MODEL: "claude-opus-5[1m]", AIGENTRY_CLAUDE_EFFORT: "MAX" });
  assert.deepEqual(out.argv.slice(3, 7), ["--model", "claude-opus-5[1m]", "--effort", "MAX"]);
  assert.ok(execLine(launcher).includes("--model 'claude-opus-5[1m]' --effort MAX"), execLine(launcher));
  assert.deepEqual(out.launch, { v: 2, cli: "claude", model: UNKNOWN, effort: UNKNOWN });
});

test("BP4 codex / agy / gemini-cli / grok: stdout launch agrees with final argv", () => {
  const cases: Array<[string, Record<string, string>, object, (a: string[]) => void]> = [
    ["codex", {}, { v: 2, cli: "codex", model: { value: "gpt-6-astra", source: "default" }, effort: { value: "high", source: "default" } },
      (a) => assert.deepEqual(a, ["codex", "-m", "gpt-6-astra", "-c", "model_reasoning_effort=high", "-c",
        "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"])],
    ["agy", {}, { v: 2, cli: "gemini", model: { value: "gemini-3.8-flash-high", source: "default" }, effort: CLI_DEF },
      (a) => { assert.deepEqual(a.slice(0, 4), ["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
        assert.equal(a[4], "--prompt-interactive"); assert.equal(a.length, 6); assert.ok(!a.includes("--effort")); }],
    ["agy", { AIGENTRY_GEMINI_EFFORT: "high" },
      { v: 2, cli: "gemini", model: { value: "gemini-3.8-flash-high", source: "default" }, effort: { value: "high", source: "env:AIGENTRY_GEMINI_EFFORT" } },
      (a) => assert.deepEqual(a.slice(0, 7), ["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions", "--effort", "high", "--prompt-interactive"])],
    ["gemini", { AIGENTRY_GEMINI_EFFORT: "high" }, { v: 2, cli: "gemini", model: { value: "gemini-2.5-flash", source: "default" }, effort: CLI_DEF },
      (a) => assert.deepEqual(a, ["gemini", "-m", "gemini-2.5-flash", "--approval-mode", "yolo", "--skip-trust"])],
    ["grok", {}, { v: 2, cli: "grok", model: { value: "grok-4.6", source: "default" }, effort: CLI_DEF },
      (a) => { assert.deepEqual(a.slice(0, 5), ["grok", "--always-approve", "-m", "grok-4.6", "--rules"]); assert.equal(a.length, 6); }],
    ["grok", { AIGENTRY_GROK_MODEL: "grok-5", AIGENTRY_GROK_EFFORT: "high" },
      { v: 2, cli: "grok", model: { value: "grok-5", source: "env:AIGENTRY_GROK_MODEL" }, effort: { value: "high", source: "env:AIGENTRY_GROK_EFFORT" } },
      (a) => assert.deepEqual(a.slice(0, 7), ["grok", "--always-approve", "-m", "grok-5", "--reasoning-effort", "high", "--rules"])],
  ];
  for (const [cli, env, launch, check] of cases) {
    const { out } = run(cli, env);
    assert.deepEqual(out.launch, launch, `${cli} ${JSON.stringify(env)}`);
    check(out.argv);
    noDup(out.argv);
  }
});
