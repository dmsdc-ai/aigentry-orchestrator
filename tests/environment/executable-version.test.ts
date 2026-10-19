import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDeclaredVersion } from "../../src/environment/executable-version.js";
import { validateSetting } from "../../src/environment/descriptors.js";
import { emptyConfig, validateConfig } from "../../src/environment/contract.js";
import { projectEnvironment, resolveSettings } from "../../src/environment/resolve.js";
import { environmentCommand } from "../../src/environment/cli.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const declaration = { version: "100.0.0", dev: 1, ino: 123, size: 456, mtimeMs: 1700000000000.25 };
const raw = JSON.stringify(declaration);
const evidence = () => import(pathToFileURL(path.join(repo, "bin/model-evidence.mjs")).href);
const invalid: unknown[] = [
  "100.0.0", "", null, declaration, "[]", "null", "true", '"100.0.0"',
  " ".repeat(1025), raw + "\n", raw.replace("100.0.0", "100.0.0\\u0085"),
  raw.replace('"version":', '"version":"1.0.0","versi\\u006fn":'),
  raw.replace('"dev":1', '"dev":2,"dev":1'),
  JSON.stringify({ ...declaration, extra: 1 }), raw.slice(0, -1) + ',"__proto__":{}}',
  raw.slice(0, -1) + ',"constructor":1}', raw.slice(0, -1) + ',"prototype":1}',
  ...Object.keys(declaration).map((key) => JSON.stringify(Object.fromEntries(Object.entries(declaration).filter(([k]) => k !== key)))),
  ...["dev", "ino", "size", "mtimeMs"].flatMap((key) => ["1", null, {}, [], -1, Number.MAX_SAFE_INTEGER + 1].map((value) => JSON.stringify({ ...declaration, [key]: value }))),
  ...["dev", "ino", "size"].map((key) => JSON.stringify({ ...declaration, [key]: 1.25 })),
  raw.replace('"dev":1', '"dev":1e999'), raw.replace('"mtimeMs":1700000000000.25', '"mtimeMs":1e999'),
  ...[123, {}, "1.0", "1.0.0+build", "123456789.0.0", "1.0.0-" + "a".repeat(33)].map((version) => JSON.stringify({ ...declaration, version })),
];

test("one bounded declaration contract rejects invalid data in config, flags, aliases and actual evidence", async () => {
  const consumer = await evidence();
  assert.equal(consumer.parseDeclaredVersion, parseDeclaredVersion, "consumer uses the same pure validator");
  for (const value of invalid) {
    assert.equal(parseDeclaredVersion(value), null, JSON.stringify(value));
    for (const cli of ["claude", "codex"]) {
      const id = `${cli}.version`, alias = `AIGENTRY_${cli.toUpperCase()}_EXECUTABLE_VERSION`;
      assert.throws(() => validateSetting(id, value), /identity-bound JSON declaration required/);
      assert.throws(() => validateConfig({ ...emptyConfig(), settings: { [id]: value } }), /ENV_INVALID_VALUE/);
      if (typeof value === "string") {
        assert.throws(() => resolveSettings({ config: emptyConfig(), env: { [alias]: value } }), /ENV_INVALID_VALUE/);
        assert.throws(() => resolveSettings({ config: emptyConfig(), env: {}, flags: { [id]: value } }), /ENV_INVALID_VALUE/);
      }
    }
  }
});

test("existing identity strings survive central layers and invocation alias projection unchanged", () => {
  const existing = '{ "mtimeMs":1700000000000.25, "size":456, "ino":123, "dev":1, "version":"100.0.0" }';
  assert.deepEqual(parseDeclaredVersion(existing), declaration);
  for (const cli of ["claude", "codex"]) {
    const id = `${cli}.version`, alias = `AIGENTRY_${cli.toUpperCase()}_EXECUTABLE_VERSION`;
    for (const source of ["settings", "profile", "env", "flag"]) {
      const c = emptyConfig();
      if (source === "settings") c.settings[id] = existing;
      if (source === "profile") { c.profiles.work = { [id]: existing }; c.selectedProfile = "work"; }
      const resolution = resolveSettings({ config: validateConfig(c), env: source === "env" ? { [alias]: existing } : {},
        flags: source === "flag" ? { [id]: existing } : {} });
      assert.equal(resolution.values[id], existing);
      assert.equal(projectEnvironment({}, resolution)[alias], existing);
    }
  }
});

test("invalid version mutation creates no central paths; an invalid persisted value is not repaired", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p1-refusal-")));
  try {
    const home = path.join(root, "missing");
    for (const value of invalid.filter((v): v is string => typeof v === "string")) {
      const result = environmentCommand(["set", "claude.version", value, "--expected-revision", "0"], { AIGENTRY_HOME: home });
      assert.equal(result.code, 2); assert.match(result.err, /ENV_INVALID_VALUE/);
      assert.equal(fs.existsSync(home), false);
    }
    assert.throws(() => validateConfig({ ...emptyConfig(), settings: { "claude.version": "100.0.0" } }), /bare version refused/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recorded fake stat binds declarations, stale identity stays unknown and npm metadata wins", async () => {
  const { collectExecutables } = await evidence();
  const executable = path.resolve(os.tmpdir(), "p1-recorded", "claude");
  const packageFile = path.join(path.dirname(executable), "package.json");
  const fakeFs = (npm: boolean) => ({
    realpathSync: (p: string) => { if (p !== executable) throw new Error("not in fixture"); return p; },
    statSync: (p: string) => {
      if (p === executable) return { ...declaration, isFile: () => true };
      if (npm && p === packageFile) return { size: 128, isFile: () => true };
      throw new Error("not in fixture");
    },
    accessSync: (p: string) => { assert.equal(p, executable); },
    readFileSync: (p: string) => { assert.equal(p, packageFile); return JSON.stringify({ name: "claude", bin: "claude", version: "2.1.283" }); },
  });
  for (const key of ["dev", "ino", "size", "mtimeMs"] as const) {
    const stale = JSON.stringify({ ...declaration, [key]: declaration[key] + 1 });
    const r = collectExecutables("claude", { declaredPath: executable, declaredVersion: stale, fsImpl: fakeFs(false) });
    assert.deepEqual([r.executables[0].version, r.executables[0].versionSource], [null, "unknown"]);
    assert.match(r.notes.join(" "), /identity differs/);
  }
  const valid = collectExecutables("claude", { declaredPath: executable, declaredVersion: raw, fsImpl: fakeFs(false) });
  assert.deepEqual([valid.executables[0].version, valid.executables[0].versionSource], ["100.0.0", "operator-declared"]);
  const npm = collectExecutables("claude", { declaredPath: executable, declaredVersion: raw, fsImpl: fakeFs(true) });
  assert.deepEqual([npm.executables[0].version, npm.executables[0].versionSource], ["2.1.283", "npm-package-metadata"]);
  for (const value of ["100.0.0", raw.replace('"dev":1', '"dev":"1"')]) {
    const malformed = collectExecutables("claude", { declaredPath: executable, declaredVersion: value, fsImpl: fakeFs(false) });
    assert.deepEqual([malformed.executables[0].version, malformed.executables[0].versionSource], [null, "unknown"]);
    assert.match(malformed.notes.join(" "), /malformed/);
  }
  const unbound = collectExecutables("claude", { pathValue: path.dirname(executable), declaredVersion: raw, fsImpl: fakeFs(false) });
  assert.deepEqual([unbound.executables[0].version, unbound.executables[0].versionSource], [null, "unknown"]);
});

test("standalone actual packed resolver consumes central declarations and refuses invalid inputs before effects", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p1-packed-")));
  try {
    const home = path.join(root, "home"), bin = path.join(root, "bin"), marker = path.join(root, "provider-called");
    fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(bin);
    const env: NodeJS.ProcessEnv = { HOME: home, AIGENTRY_HOME: path.join(home, ".aigentry"), PATH: bin, MARKER: marker };
    const run = (cmd: string, args: string[], overlay: NodeJS.ProcessEnv = {}, cwd = root) =>
      spawnSync(cmd, args, { cwd, env: { ...env, ...overlay }, encoding: "utf8", timeout: 60000 });
    // Real package files[], offline, hooks disabled. No dependency symlink is
    // needed: direct actual evidence avoids the copied router precondition FAIL.
    const packed = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, npm_config_cache: path.join(root, "cache"), npm_config_offline: "true" }, repo);
    assert.equal(packed.status, 0, packed.stderr);
    const archive = path.join(root, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
    const unpacked = run("/usr/bin/tar", ["-xf", archive, "-C", root]); assert.equal(unpacked.status, 0, unpacked.stderr);
    const pkg = path.join(root, "package"), cli = path.join(pkg, "bin/init/cli.mjs");
    assert.equal(fs.existsSync(path.join(pkg, "dist/src/environment/executable-version.js")), true);
    assert.equal(fs.existsSync(path.join(pkg, "bin/lib/executable-version.mjs")), true);
    assert.equal(fs.existsSync(path.join(pkg, "bin/lib/environment-runtime.mjs")), true);
    const provider = path.join(bin, "claude");
    fs.writeFileSync(provider, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.MARKER,'called');process.exit(99);\n`, { mode: 0o700 });
    const st = fs.statSync(fs.realpathSync(provider));
    const bound = JSON.stringify({ version: "100.0.0", dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
    const settings = [["catalog.metadata", "off"], ["claude.model", "claude-opus-5-5"], ["claude.effort", "high"], ["claude.executable", provider], ["claude.version", bound]];
    const rejected = run(process.execPath, [cli, "env", "set", "claude.version", "100.0.0", "--expected-revision", "0"]);
    assert.equal(rejected.status, 2); assert.match(rejected.stderr, /bare version refused/);
    assert.equal(fs.existsSync(env.AIGENTRY_HOME!), false);
    for (let revision = 0; revision < settings.length; revision++) {
      const result = run(process.execPath, [cli, "env", "set", ...settings[revision]!, "--expected-revision", String(revision)]);
      assert.equal(result.status, 0, result.stderr);
    }
    const config = path.join(env.AIGENTRY_HOME!, "environment/config.json"), bytes = fs.readFileSync(config);
    assert.equal(JSON.parse(bytes.toString()).settings["claude.version"], bound);
    // Copied evidence carries the pure shared parser; managed resolution uses
    // the registered installed package runtime, without executing its entrypoint.
    const copied = path.join(root, "copied");
    fs.mkdirSync(path.join(copied, "bin"), { recursive: true });
    fs.mkdirSync(path.join(copied, "docs/model-profiles"), { recursive: true });
    fs.mkdirSync(path.join(copied, "bin/lib"));
    for (const name of ["lib/executable-version.mjs", "lib/environment-runtime.mjs", "model-evidence.mjs", "model-resolve.mjs"]) fs.copyFileSync(path.join(pkg, "bin", name), path.join(copied, "bin", name));
    fs.copyFileSync(path.join(pkg, "docs/model-profiles/model-catalog.json"), path.join(copied, "docs/model-profiles/model-catalog.json"));
    fs.symlinkSync(cli, path.join(bin, "aigentry-orchestrator"));
    const child = "const m=await import(process.argv[1]);const r=await m.resolveCommand(process.argv.slice(2),process.env,{transport:()=>{throw new Error('network tripwire')}});process.stdout.write(r.out);process.exit(r.code);";
    const args = ["--cli", "claude", "--sid", "fixture-worker", "--task", "1233"];
    for (const layout of [pkg, copied]) {
      const resolve = (extra: string[] = [], overlay: NodeJS.ProcessEnv = {}) => run(process.execPath,
        ["--input-type=module", "-e", child, pathToFileURL(path.join(layout, "bin/model-evidence.mjs")).href, ...args, ...extra], overlay);
      for (const [extra, overlay] of [[[], {}], [[], { AIGENTRY_CLAUDE_EXECUTABLE_VERSION: bound }], [["--executable-version", bound], {}]] as Array<[string[], NodeJS.ProcessEnv]>) {
        const result = resolve(extra, overlay); assert.equal(result.status, 0, result.stdout + result.stderr);
        const d = JSON.parse(result.stdout).decision;
        assert.deepEqual([d.executable.path, d.executable.version, d.executable.versionSource], [provider, "100.0.0", "operator-declared"]);
        assert.deepEqual([d.model, d.effort.token], ["claude-opus-5-5", "high"]);
      }
      for (const value of ["100.0.0", bound.replace('"dev":', '"extra":0,"dev":')]) {
        for (const [extra, overlay] of [[["--executable-version", value], {}], [[], { AIGENTRY_CLAUDE_EXECUTABLE_VERSION: value }]] as Array<[string[], NodeJS.ProcessEnv]>) {
          const result = resolve(extra, overlay); assert.equal(result.status, 4, result.stderr);
          assert.equal(JSON.parse(result.stdout).refusal.code, "ENV_CONFIGURATION_REFUSED");
        }
      }
      assert.deepEqual(fs.readFileSync(config), bytes);
      assert.equal(fs.existsSync(marker), false, "no provider invocation or version probe");
    }
    fs.appendFileSync(provider, "// replacement after recorded stat\n");
    const stale = run(process.execPath, ["--input-type=module", "-e", child, pathToFileURL(path.join(pkg, "bin/model-evidence.mjs")).href, ...args]);
    assert.equal(stale.status, 0, stale.stdout + stale.stderr);
    const d = JSON.parse(stale.stdout).decision;
    assert.deepEqual([d.executable.version, d.executable.versionSource], [null, "unknown"]);
    assert.match(d.rationale, /identity differs/);
    assert.deepEqual([d.executable.path, d.model, d.effort.token], [provider, "claude-opus-5-5", "high"]);
    assert.deepEqual(fs.readFileSync(config), bytes); assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
