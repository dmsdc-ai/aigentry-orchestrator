import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as helper from "../../src/environment/helper-env.js";
import { assertFixtureRoot, childEnv, finish, fixture as managedFixture } from "./s2-acceptance/fixture.js";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const boot = join(repo, "bin", "boot-prepare.mjs");
const runner = fileURLToPath(new URL("../../src/session/worker-sandbox-runner.js", import.meta.url));
const driver = fileURLToPath(new URL("./s2-acceptance/_managed-driver.js", import.meta.url));
const preload = fileURLToPath(new URL("./s2-acceptance/_runner-preload.js", import.meta.url));
const canaries = ["AWS_SECRET_ACCESS_KEY", "VAULT_ADDR", "DISPATCH_STATE_DIR", "TELEPTY", "BASH_ENV", "NODE_OPTIONS"];

// Extract the actual boot caller so the child request can be intercepted without
// executing the installer or a real boot. The markers fail closed if it moves.
const bootSource = readFileSync(boot, "utf8");
const start = bootSource.indexOf("function ensureInstructionsTree(");
const end = bootSource.indexOf("\nfunction shellQuote(", start);
assert.ok(start >= 0 && end > start);
const installerCaller = bootSource.slice(start, end);

function installerFixture() {
  const root = mkdtempSync(join(tmpdir(), "startup-installer-"));
  const home = join(root, "home"), bin = join(root, "bin"), environment = join(root, "environment");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(environment, { mode: 0o700 });
  const bash = join(bin, "bash"), installer = join(bin, "install-instructions.sh");
  writeFileSync(bash, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(installer, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const source: NodeJS.ProcessEnv = { AIGENTRY_HOME: home, HOME: "/poisoned-host-home", PATH: bin,
    AWS_SECRET_ACCESS_KEY: "poison", VAULT_ADDR: "poison", DISPATCH_STATE_DIR: "poison",
    TELEPTY: "poison", BASH_ENV: "poison", NODE_OPTIONS: "--no-warnings" };
  const runtime = helper.captureManagedRuntime(source, environment);
  return { root, home, bin, bash, installer, source, runtime, common: join(home, "instructions", "common.md") };
}

function invokeInstaller(f: ReturnType<typeof installerFixture>, managed: boolean,
  onSpawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => { status: number; stderr: string },
  boundary: typeof helper = helper): string {
  const context = { REPO_ROOT: f.root, process: { env: f.source }, join, existsSync,
    instructionsRoot: () => join(f.home, "instructions"),
    spawnSync: onSpawn, die: (message: string): never => { throw new Error(message); } };
  const call = runInNewContext(`(${installerCaller})`, context) as
    (runtime: helper.TrustedRuntimeContext | null, boundary: typeof helper | null) => string;
  return call(managed ? f.runtime : null, managed ? boundary : null);
}

test("managed missing instructions project only installer inputs; present instructions request no child", () => {
  const f = installerFixture();
  try {
    let requests = 0;
    const request = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      requests++;
      assert.equal(command, f.bash);
      assert.deepEqual(Array.from(args), [f.installer]);
      assert.equal(options.env.AIGENTRY_HOME, f.home);
      assert.equal(options.env.HOME, f.runtime.base.HOME);
      assert.equal(options.env.PATH, f.runtime.base.PATH);
      for (const key of canaries) assert.equal(Object.hasOwn(options.env, key), false, key);
      mkdirSync(dirname(f.common), { recursive: true, mode: 0o700 });
      writeFileSync(f.common, "# common\n");
      return { status: 0, stderr: "" };
    };
    assert.equal(invokeInstaller(f, true, request), join(f.home, "instructions"));
    assert.equal(requests, 1);
    assert.equal(invokeInstaller(f, true, request), join(f.home, "instructions"));
    assert.equal(requests, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("managed installer refuses replacement of pinned interpreter and script before child request", () => {
  for (const replaced of ["bash", "script"] as const) {
    const f = installerFixture();
    try {
      let requests = 0;
      const replacement = join(f.bin, "replacement");
      writeFileSync(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const boundary = {
        ...helper,
        assertTrustedTool: (runtime: helper.TrustedRuntimeContext, name: string, file: string) => {
          if (replaced === "bash") renameSync(replacement, f.bash);
          helper.assertTrustedTool(runtime, name, file);
        },
        assertTrustedFile: (runtime: helper.TrustedRuntimeContext, op: helper.HelperOperation, file: string,
          executable = true) => {
          if (replaced === "script") renameSync(replacement, f.installer);
          helper.assertTrustedFile(runtime, op, file, executable);
        },
      };
      assert.throws(() => invokeInstaller(f, true, () => { requests++; return { status: 0, stderr: "" }; }, boundary),
        /ENV_HELPER_PATH_REFUSED/);
      assert.equal(requests, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("legacy missing instructions keep their native caller environment", () => {
  const f = installerFixture();
  try {
    assert.equal(invokeInstaller(f, false, (command, args, options) => {
      assert.equal(command, "bash");
      assert.deepEqual(Array.from(args), [f.installer]);
      for (const key of canaries) assert.equal(options.env[key], f.source[key]);
      mkdirSync(dirname(f.common), { recursive: true, mode: 0o700 });
      writeFileSync(f.common, "# common\n");
      return { status: 0, stderr: "" };
    }), join(f.home, "instructions"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("runner refuses missing and invalid manifests before SRT; valid sealed managed manifest reaches SRT with admitted keys", { skip: process.platform === "win32" }, () => {
  const root = managedFixture();
  try {
    const prepared = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
      env: { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: "prepare" },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const info = JSON.parse(readFileSync(join(root, "managed-info.json"), "utf8")) as { manifest: string; hash: string };
    const manifest = JSON.parse(readFileSync(info.manifest, "utf8")) as { env: Record<string, string> };
    const record = join(root, "srt-import.json");
    const loader = join(root, "srt-loader.mjs"), registration = join(root, "register.mjs");
    const fakeSrt = `import * as fs from "node:fs";\n` +
      `export const SandboxManager = Object.freeze({});\n` +
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ keys: Object.keys(process.env).sort() }), { flag: "wx", mode: 0o600 });\n` +
      `throw new Error("STOP_AT_SRT_IMPORT");\n`;
    writeFileSync(loader, `export async function resolve(s, c, next) {\n` +
      `  if (s === "@anthropic-ai/sandbox-runtime") return { url: "startup:srt", shortCircuit: true };\n` +
      `  return next(s, c);\n}\n` +
      `export async function load(url, c, next) {\n` +
      `  if (url === "startup:srt") return { format: "module", source: ${JSON.stringify(fakeSrt)}, shortCircuit: true };\n` +
      `  return next(url, c);\n}\n`);
    writeFileSync(registration, `import { register } from "node:module";\n` +
      `register(${JSON.stringify(loader)}, import.meta.url);\n`);
    const env = { ...childEnv(root), AWS_SECRET_ACCESS_KEY: "poison", VAULT_ADDR: "poison",
      DISPATCH_STATE_DIR: "poison", TELEPTY: "poison", BASH_ENV: "poison", NODE_OPTIONS: "--no-warnings" };
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", registration, runner, ...args],
      { env, encoding: "utf8", timeout: 30_000 });
    const missing = run([]);
    assert.equal(missing.status, 78, missing.stderr);
    assert.match(missing.stderr, /SANDBOX_MANIFEST_REQUIRED/);
    assert.equal(existsSync(record), false);
    const invalid = run([info.manifest, "0".repeat(64)]);
    assert.equal(invalid.status, 78, invalid.stderr);
    assert.match(invalid.stderr, /SANDBOX_MANIFEST_CHANGED/);
    assert.equal(existsSync(record), false);
    const valid = run([info.manifest, info.hash]);
    assert.equal(valid.status, 78, valid.stderr);
    assert.match(valid.stderr, /STOP_AT_SRT_IMPORT/);
    const observed = JSON.parse(readFileSync(record, "utf8")) as { keys: string[] };
    assert.deepEqual(observed.keys, Object.keys(manifest.env).sort());
    for (const key of ["HOME", "PATH", "TMPDIR"]) assert.ok(observed.keys.includes(key), key);
    for (const key of canaries) assert.equal(observed.keys.includes(key), false, key);
  } finally { finish(root, { control: "startup runner import boundary" }); }
});

test("startup fixtures allocate distinct private roots under an existing shared parent", () => {
  const first = managedFixture(), second = managedFixture();
  try {
    assert.notEqual(first, second);
    assertFixtureRoot(first);
    assertFixtureRoot(second);
    assert.equal(dirname(dirname(first)), dirname(dirname(second)));
  } finally {
    finish(first, { control: "first startup root" });
    finish(second, { control: "second startup root" });
  }
});
