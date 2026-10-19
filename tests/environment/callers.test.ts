import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { emptyConfig } from "../../src/environment/contract.js";
import { dispatchOptionArgs, parseDispatchInvocation } from "../../src/environment/invocation.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const guard = path.join(repo, "tests/environment/caller-guard.cjs");
const posix = ["darwin", "linux"].includes(process.platform);
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-callers-")));
  const home = path.join(root, "home"), a = path.join(root, "project-a"), b = path.join(root, "project-b");
  for (const dir of [home, a, b]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "ref.md"), "Task1233 fixture.\n");
  fs.writeFileSync(path.join(root, "queue.json"), '{"tasks":[{"id":1233,"status":"pending"}]}');
  const config = emptyConfig();
  config.settings = { "dispatch.cli": "claude", "claude.model": "global-model" };
  config.selectedProfile = "work"; config.profiles.work = { "claude.model": "profile-model" };
  config.projects[a] = { "claude.model": "project-model" }; config.projects[b] = { "claude.model": "other-project-model" };
  fs.mkdirSync(path.join(home, "environment"), { mode: 0o700 });
  const central = path.join(home, "environment/config.json");
  fs.writeFileSync(central, JSON.stringify(config), { mode: 0o600 });
  let sequence = 0;
  const run = (entry: string, args: string[], mode: string, platform?: string, overlay: NodeJS.ProcessEnv = {}) => {
    const events = path.join(root, `events-${sequence}.jsonl`), spec = path.join(root, `spec-${sequence++}.json`);
    fs.writeFileSync(spec, JSON.stringify({ events, mode, platform, hostPlatform: process.platform }));
    const result = spawnSync(process.execPath, ["--require", guard, entry, ...args], { cwd: a, encoding: "utf8", timeout: 10000,
      env: { HOME: home, AIGENTRY_HOME: home, PATH: path.dirname(process.execPath), S1_CALLER_SPEC: spec,
        AIGENTRY_TASK_QUEUE: path.join(root, "queue.json"), AIGENTRY_TASK_GATE: "hard", AIGENTRY_MODEL_METADATA: "off", ...overlay } });
    const recorded = fs.readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; code?: number; args?: string[]; targetCwd?: string });
    assert.equal(result.signal, null); assert.ok(recorded.some((e) => e.kind === "exit" && e.code === result.status));
    assert.equal(recorded.some((e) => ["write", "auth-read", "network", "signal", "unexpected-child"].includes(e.kind)), false, JSON.stringify(recorded));
    return { ...result, recorded };
  };
  return { root, home, a, b, central, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("dispatch parser counts context options only within its actual option boundary", () => {
  const parsed = parseDispatchInvocation(["--ref", "--model", "--cli", "claude", "--model", "flag-model"]);
  assert.equal(parsed.values["--ref"], "--model");
  assert.equal(parsed.context.flags["claude.model"], "flag-model");
  assert.equal(parseDispatchInvocation(["-h", "--cli", "claude", "--cli", "codex"]).help, true);
  assert.deepEqual(dispatchOptionArgs(["__probe", "dispatch-ref", "--ref", "file", "--cli"]), ["--ref", "file"]);
  assert.deepEqual(dispatchOptionArgs(["__probe", "is-ready", "--model", "--model"]), []);
});

test("actual dispatch refuses duplicate or missing context values before every effect", { skip: !posix }, () => {
  const f = fixture(), entry = path.join(repo, "dist/src/dispatch/cli.js");
  const before = fs.readFileSync(f.central);
  const base = ["--spawn-and-dispatch", "--track", "fixture", "--name", "coder", "--ref", path.join(f.root, "ref.md"), "--task", "1233"];
  const version = JSON.stringify({ version: "100.0.0", dev: 1, ino: 2, size: 3, mtimeMs: 4.25 });
  try {
    const duplicates = [["--cli", "claude", "codex"], ["--cwd", f.a, f.b], ["--role", "coder", "tester"],
      ["--model", "flag-model", "other-model"], ["--effort", "high", "medium"], ["--executable", "/fixture/claude", "/other/claude"],
      ["--executable-version", version, version]];
    for (const [option, first, second] of duplicates) {
      for (const values of [[first!, second!], [second!, first!]]) {
        const r = f.run(entry, [...base, ...(option === "--cli" ? [] : ["--cli", "claude"]), option!, values[0]!, option!, values[1]!], "dispatch");
        assert.equal(r.status, 4, r.stderr); assert.match(r.stderr, /ENV_DUPLICATE_OPTION/); assert.ok(r.stderr.includes(option!));
        assert.deepEqual(r.recorded.filter((e) => e.kind === "child"), []);
      }
    }
    for (const option of duplicates.map((row) => row[0]!)) {
      for (const tail of [[], ["--help"], [""]]) {
        const r = f.run(entry, [...base, ...(option === "--cli" ? [] : ["--cli", "claude"]), option, ...tail], "dispatch");
        assert.equal(r.status, 4); assert.match(r.stderr, /ENV_OPTION_VALUE_REQUIRED/);
        assert.deepEqual(r.recorded.filter((e) => e.kind === "child"), []);
      }
    }
    assert.deepEqual(fs.readFileSync(f.central), before);
    const help = f.run(entry, ["--help", "--cli", "claude", "--cli", "codex"], "dispatch");
    assert.equal(help.status, 0); assert.deepEqual(help.recorded.filter((e) => e.kind === "child"), []);
    const unknown = f.run(entry, ["untrusted-canary-argument"], "dispatch");
    assert.equal(unknown.status, 4); assert.match(unknown.stderr, /DISPATCH_UNKNOWN_ARGUMENT/);
    assert.doesNotMatch(unknown.stderr, /untrusted-canary-argument/);
  } finally { f.cleanup(); }
});

test("actual dispatch retains the single typed tuple and canonical project/role at the real resolver boundary", { skip: !posix }, () => {
  const f = fixture(), entry = path.join(repo, "dist/src/dispatch/cli.js");
  try {
    const declaration = JSON.stringify({ version: "100.0.0", dev: 1, ino: 2, size: 3, mtimeMs: 4.25 });
    const tuple = ["--model", "flag-model", "--effort", "high", "--executable", "/fixture/claude", "--executable-version", declaration];
    const r = f.run(entry, ["--spawn-and-dispatch", "--track", "fixture", "--name", "coder", "--ref", path.join(f.root, "ref.md"), "--task", "1233",
      "--cli", "claude", "--cwd", f.a, "--role", "coder", ...tuple], "dispatch", undefined, { AIGENTRY_CLAUDE_MODEL: "env-model" });
    assert.equal(r.status, 86, r.stderr);
    const resolver = r.recorded.find((e) => e.kind === "child" && e.args?.includes("--resolve"));
    assert.ok(resolver); assert.equal(resolver.targetCwd, f.a);
    assert.equal(resolver.args![resolver.args!.indexOf("--role") + 1], "coder");
    assert.equal(resolver.args![resolver.args!.indexOf("--cli") + 1], "claude");
    for (let i = 0; i < tuple.length; i += 2) assert.equal(resolver.args![resolver.args!.indexOf(tuple[i]!) + 1], tuple[i + 1]);
  } finally { f.cleanup(); }
});

test("simulated win32 legacy reads reach real metadata/help/version/init paths while protected mutation refuses", { skip: !posix }, () => {
  const f = fixture(), entry = path.join(repo, "bin/init/cli.mjs"), legacy = path.join(f.home, "config.json");
  try {
    const protectedBytes = fs.readFileSync(f.central);
    const protectedRead = f.run(entry, ["env", "doctor", "--json"], "metadata", "win32");
    assert.equal(protectedRead.status, 2); assert.match(protectedRead.stderr, /ENV_PROTECTION_UNAVAILABLE/);
    assert.deepEqual(fs.readFileSync(f.central), protectedBytes);
    fs.rmSync(path.join(f.home, "environment"), { recursive: true });
    const absent = f.run(entry, ["env", "doctor", "--json"], "metadata", "win32");
    assert.equal(absent.status, 0); assert.equal(fs.existsSync(legacy), false);
    const bytes = '{"defaults":{"cli":"claude","model":"legacy-model"},"foreign":{"keep":true}}\n';
    fs.writeFileSync(legacy, bytes, { mode: 0o644 });
    for (const platform of ["win32", process.platform]) {
      for (const args of [["--help"], ["--version"], ["env", "doctor", "--json"], ["env", "list", "--json"]]) {
        const r = f.run(entry, args, "metadata", platform);
        assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.recorded.filter((e) => e.kind === "child"), []);
        if (args[1] === "list") assert.equal(JSON.parse(r.stdout).settings.find((d: { id: string }) => d.id === "boot.model").value, "legacy-model");
      }
    }
    const mutation = f.run(entry, ["env", "set", "claude.model", "flag-model", "--expected-revision", "0"], "metadata", "win32");
    assert.equal(mutation.status, 2); assert.match(mutation.stderr, /ENV_PROTECTION_UNAVAILABLE/);
    assert.equal(fs.existsSync(path.join(f.home, "environment")), false); assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
    // Init reaches the existing Windows prerequisite refusal, proving bootstrap
    // no longer rejects legacy config. Dependency execution remains intercepted.
    const init = f.run(entry, ["init", "--yes"], "metadata", "win32");
    assert.equal(init.status, 3, init.stderr); assert.doesNotMatch(init.stderr, /ENV_CONFIGURATION_REFUSED|ENV_PROTECTION_UNAVAILABLE/);
    for (const raw of ['{"defaults":{},"defaults":{}}', '{"constructor":1}', '{bad', " ".repeat(128 * 1024 + 1)]) {
      fs.writeFileSync(legacy, raw);
      const r = f.run(entry, ["env", "doctor", "--json"], "metadata", "win32");
      assert.equal(r.status, 2); assert.doesNotMatch(r.stderr, /ENV_PROTECTION_UNAVAILABLE/);
    }
    fs.writeFileSync(legacy, Buffer.from([0xff]));
    assert.match(f.run(entry, ["env", "doctor", "--json"], "metadata", "win32").stderr, /ENV_UTF8_INVALID/);
  } finally { f.cleanup(); }
});
