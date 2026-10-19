import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const posix = ["darwin", "linux"].includes(process.platform);
const require = createRequire(import.meta.url);
const fixtureScript = (bin: string, name: string, body: string) => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
};

test("real npm archive entrypoint, init copy inventory, installed/copied boot and model-router callers", { skip: !posix }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-packed-")));
  const bin = path.join(root, "bin"), home = path.join(root, "home"), aig = path.join(home, ".aigentry"), ws = path.join(root, "workspace");
  fs.mkdirSync(bin); fs.mkdirSync(home, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: home, AIGENTRY_HOME: aig, PATH: `${bin}:/usr/bin:/bin`, AIGENTRY_HANDOFF: "off", BOOT_LOG: path.join(root, "boot.json") };
  const run = (cmd: string, args: string[], cwd = root, overlay: NodeJS.ProcessEnv = {}) => spawnSync(cmd, args, { cwd, env: { ...env, ...overlay }, encoding: "utf8", timeout: 60000 });
  try {
    // Pack real files[] with hooks disabled and a fixture-local cache. No install,
    // provider, native daemon or network is used by this suite.
    const pack = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], repo,
      { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, npm_config_cache: path.join(root, "cache"), npm_config_offline: "true" });
    assert.equal(pack.status, 0, pack.stderr);
    const archive = path.join(root, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);
    const unpack = run("tar", ["-xf", archive, "-C", root]); assert.equal(unpack.status, 0, unpack.stderr);
    const pkg = path.join(root, "package"), cli = path.join(pkg, "bin/init/cli.mjs");
    // Dependencies only: no product source is reachable through this link.
    const dependencyRoot = path.resolve(require.resolve("cross-spawn/package.json"), "../..");
    fs.symlinkSync(dependencyRoot, path.join(pkg, "node_modules"), "dir");
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    fs.symlinkSync(cli, path.join(bin, "aigentry-orchestrator"));
    fixtureScript(bin, "jq", "console.log('{}')"); fixtureScript(bin, "python3", "process.exit(0)");
    fixtureScript(bin, "git", "process.exit(1)");
    fixtureScript(bin, "ps", "console.log('PID PPID COMMAND')");
    const provider = fixtureScript(bin, "claude", "require('node:fs').writeFileSync(process.env.BOOT_LOG,'provider-called'); process.exit(99)");
    const st = fs.statSync(fs.realpathSync(provider));
    const declaration = JSON.stringify({ version: "100.0.0", dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
    fixtureScript(bin, "telepty", `const fs=require('node:fs'); if(process.argv[2]==='list') { console.log('{}'); }
      else if(process.argv[2]==='allow') fs.writeFileSync(process.env.BOOT_LOG, JSON.stringify({ argv:process.argv.slice(2), model:process.env.AIGENTRY_BOOT_MODEL, sid:process.env.ORCHESTRATOR_SID }));
      else process.exit(99);`);
    const metadata = run(process.execPath, [cli, "env", "doctor", "--json"]);
    assert.equal(metadata.status, 0, metadata.stderr); assert.equal(fs.existsSync(aig), false);
    for (const args of [["set", "runtime.sid", "fake"], ["set", "claude.model", "bad value"], ["set", "claude.version", "100.0.0"]]) {
      const rejected = run(process.execPath, [cli, "env", ...args, "--expected-revision", "0"]);
      assert.equal(rejected.status, 2); assert.equal(fs.existsSync(aig), false);
    }
    const settings = [["boot.cli", "claude"], ["boot.model", "claude-opus-5-5"], ["boot.sid", "fixture-orchestrator"], ["catalog.metadata", "off"],
      ["claude.model", "claude-opus-5-5"], ["claude.effort", "high"], ["claude.executable", provider], ["claude.version", declaration]];
    for (let revision = 0; revision < settings.length; revision++) {
      const r = run(process.execPath, [cli, "env", "set", ...settings[revision]!, "--expected-revision", String(revision)]);
      assert.equal(r.status, 0, r.stderr);
    }
    // B3: use the archived entrypoint from the actual invocation project,
    // with distinct project/profile/global workspaces and an explicit override.
    const project = path.join(root, "project-a"), unrelated = path.join(root, "project-b");
    fs.mkdirSync(project); fs.mkdirSync(unrelated);
    const workspaces = { global: path.join(root, "ws-global"), profile: path.join(root, "ws-profile"),
      project: path.join(root, "ws-project"), explicit: path.join(root, "ws-explicit") };
    const scoped = [
      ["set", "control.workspace", workspaces.global],
      ["set", "control.workspace", workspaces.profile, "--profile", "work"],
      ["profile", "select", "work"],
      ["set", "control.workspace", workspaces.project, "--project", project],
    ];
    for (let i = 0; i < scoped.length; i++) {
      const r = run(process.execPath, [cli, "env", ...scoped[i]!, "--expected-revision", String(settings.length + i)]);
      assert.equal(r.status, 0, r.stderr);
    }
    const centralBeforeInit = fs.readFileSync(path.join(aig, "environment/config.json"));
    const { MANIFEST } = await import(path.join(pkg, "bin/init/manifest.mjs")) as { MANIFEST: string[] };
    assert.equal(MANIFEST.length, 85);
    for (const [cwd, chosen, options] of [
      [project, workspaces.project, []], [unrelated, workspaces.profile, []],
      [project, workspaces.explicit, ["--workspace", workspaces.explicit]],
    ] as const) {
      const r = run(process.execPath, [cli, "init", "--yes", ...options], cwd);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(`workspace: ${chosen}`));
      for (const member of MANIFEST) assert.equal(fs.existsSync(path.join(chosen, member)), true, member);
      assert.equal(JSON.parse(fs.readFileSync(path.join(chosen, ".aigentry-init.json"), "utf8")).workspace, chosen);
      assert.deepEqual(fs.readFileSync(path.join(aig, "environment/config.json")), centralBeforeInit);
    }
    assert.equal(fs.existsSync(workspaces.global), false);
    const config = path.join(aig, "environment/config.json"), bytes = fs.readFileSync(config);
    const init = run(process.execPath, [cli, "init", "--workspace", ws, "--yes"]);
    assert.equal(init.status, 0, init.stderr);
    assert.deepEqual(fs.readFileSync(config), bytes, "init preserves canonical config");
    assert.equal(fs.readFileSync(path.join(ws, "docs/setup/environment.md"), "utf8"), fs.readFileSync(path.join(pkg, "docs/setup/environment.md"), "utf8"));
    assert.equal(fs.existsSync(path.join(ws, "dist")), false, "copied workspace must resolve installed dist");
    assert.equal(fs.existsSync(path.join(ws, "node_modules")), false, "copied router uses installed package dependencies");
    for (const helper of ["executable-version.mjs", "environment-runtime.mjs"]) {
      assert.deepEqual(fs.readFileSync(path.join(ws, "bin/lib", helper)), fs.readFileSync(path.join(pkg, "bin/lib", helper)));
    }
    const plan = { AIGENTRY_BOOT_PLAN: "1", AIGENTRY_BOOT_PERMISSION: "approval=manual", AIGENTRY_BOOT_HISTORY: "new" };
    for (const layout of [pkg, ws]) {
      const shim = path.join(layout, "bin/orchestrator-boot.sh");
      for (const args of [["--help"], ["--dry-run"], ["--bogus"], ["__probe", "exec-argv"]]) {
        const result = run("bash", [shim, ...args], root, plan);
        if (args[0] !== "--bogus") assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(env.BOOT_LOG!), false, "every argv mode is no-exec");
        if (args[0] === "__probe") {
          const argv = result.stdout.trimEnd().split("\n");
          assert.deepEqual(argv.slice(0, 5), ["telepty", "allow", "--id", "fixture-orchestrator", "--auto-restart"]);
          assert.ok(argv.includes("claude-opus-5-5")); assert.doesNotMatch(result.stdout, /readiness|capabilities|revision/);
        }
      }
      const boot = run("bash", [shim], root, plan);
      assert.equal(boot.status, 0, boot.stderr);
      const observed = JSON.parse(fs.readFileSync(env.BOOT_LOG!, "utf8")) as { model: string; sid: string };
      assert.equal(observed.model, "claude-opus-5-5", "real parent-shell exec receives central setting");
      assert.equal(observed.sid, "fixture-orchestrator");
      assert.match(boot.stderr, /authentication-unobserved/); assert.equal(boot.stdout, "");
      fs.unlinkSync(env.BOOT_LOG!);
      const router = run(process.execPath, [path.join(layout, "bin/model-router.mjs"), "--role", "coder", "--confined", "1"]);
      assert.equal(router.status, 0, router.stderr); assert.ok(JSON.parse(router.stdout).model);
      const resolved = run(process.execPath, [path.join(layout, "bin/model-router.mjs"), "--resolve", "--cli", "claude", "--sid", "fixture-worker", "--task", "1233", "--role", "coder"]);
      assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
      const decision = JSON.parse(resolved.stdout).decision;
      assert.equal(decision.model, "claude-opus-5-5"); assert.equal(decision.effort.token, "high");
      assert.equal(decision.executable.path, provider); assert.equal(decision.requested.source, "settings");
      assert.equal(decision.executable.version, "100.0.0"); assert.equal(decision.executable.versionSource, "operator-declared");
      assert.equal(fs.existsSync(env.BOOT_LOG!), false, "resolver never probes or executes provider");
      const dispatch = run("bash", [path.join(layout, "bin/dispatch.sh"), "--help"]);
      assert.equal(dispatch.status, 0, dispatch.stderr);
      const rejected = run("bash", [path.join(layout, "bin/dispatch.sh"), "--help"], root, { AIGENTRY_CLAUDE_MODEL: "bad value" });
      assert.equal(rejected.status, 4); assert.equal(fs.existsSync(env.BOOT_LOG!), false);
    }
    fs.unlinkSync(path.join(pkg, "node_modules"));
    for (const routerArgs of [["--role", "coder", "--confined", "1"], ["--resolve", "--cli", "claude", "--sid", "fixture-worker", "--task", "1233"]]) {
      const missing = run(process.execPath, [path.join(ws, "bin/model-router.mjs"), ...routerArgs]);
      assert.equal(missing.status, 4, missing.stdout + missing.stderr);
      assert.doesNotMatch(missing.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|\n\s+at /);
      if (routerArgs[0] === "--resolve") assert.equal(JSON.parse(missing.stdout).refusal.code, "ENV_CONFIGURATION_REFUSED");
      else assert.match(missing.stderr, /ENV_CONFIGURATION_REFUSED/);
      assert.equal(fs.existsSync(env.BOOT_LOG!), false, "missing dependency refuses before any provider/terminal effect");
    }
    assert.deepEqual(fs.readFileSync(config), bytes, "all read-only callers preserve central bytes");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
