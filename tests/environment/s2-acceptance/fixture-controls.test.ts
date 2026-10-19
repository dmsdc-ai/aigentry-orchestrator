import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeOverlaySupported } from "../../../src/environment/helper-env.js";
import { prepareWorkerSandbox } from "../../../src/session/worker-sandbox.js";
import { assertFixtureSrtSpawn, fixtureSrtWrapper, load } from "./_srt-loader.js";
import { assertFixtureRoot, childEnv, finish, fixture } from "./fixture.js";

test("fixture reuses only its private owned directory and allocates unique private roots", async () => {
  const outer = fixture();
  const copied = path.join(outer, "fixture-copy.js");
  fs.copyFileSync(fileURLToPath(new URL("./fixture.js", import.meta.url)), copied);
  const isolated = await import(pathToFileURL(copied).href) as typeof import("./fixture.js");
  const first = isolated.fixture(), second = isolated.fixture();
  assert.notEqual(first, second);
  for (const root of [first, second]) {
    const stat = fs.lstatSync(root);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o077, 0);
    if (process.getuid) assert.equal(stat.uid, process.getuid());
    assert.doesNotThrow(() => assertFixtureRoot(root));
  }
  assert.throws(() => assertFixtureRoot(path.join(outer, "foreign")));
  isolated.finish(first, { control: "private root" });
  isolated.finish(second, { control: "private root" });
  finish(outer, { controls: "repeated private allocation" });
});

test("fixture refuses a symlink, a file and an insecure existing parent", { skip: process.platform === "win32" }, async () => {
  const outer = fixture();
  const copied = path.join(outer, "fixture-copy.js");
  fs.copyFileSync(fileURLToPath(new URL("./fixture.js", import.meta.url)), copied);
  const priorTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = outer;
  let isolated: typeof import("./fixture.js");
  try { isolated = await import(pathToFileURL(copied).href) as typeof import("./fixture.js"); }
  finally {
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
  const parent = path.join(outer, `aigentry-s2-acceptance-${process.getuid?.() ?? "user"}`);
  const target = path.join(outer, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, parent, "dir");
  assert.throws(() => isolated.fixture());
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(parent);
  fs.writeFileSync(parent, "not a directory", { flag: "wx", mode: 0o600 });
  assert.throws(() => isolated.fixture());
  fs.unlinkSync(parent);
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o755);
  assert.throws(() => isolated.fixture());
  assert.deepEqual(fs.readdirSync(parent), []);
  finish(outer, { controls: "symlink, file and insecure parent refused" });
});

test("finish removes owned read-only descendants without changing a linked control root", { skip: process.platform === "win32" }, () => {
  const root = fixture(), control = fixture();
  const nested = path.join(root, "nested"), deeper = path.join(nested, "deeper");
  fs.mkdirSync(nested, { mode: 0o700 });
  fs.mkdirSync(deeper, { mode: 0o700 });
  const ownedFile = path.join(deeper, "read-only.txt");
  fs.writeFileSync(ownedFile, "owned bytes", { flag: "wx", mode: 0o400 });
  const controlFile = path.join(control, "control.txt");
  fs.writeFileSync(controlFile, "control bytes", { flag: "wx", mode: 0o400 });
  fs.symlinkSync(control, path.join(deeper, "external-control"), "dir");
  fs.chmodSync(deeper, 0o500);
  fs.chmodSync(nested, 0o500);
  const unallocated = path.join(path.dirname(root), randomUUID());
  fs.mkdirSync(unallocated, { mode: 0o700 });
  assert.throws(() => finish(unallocated, { control: "must refuse" }));
  assert.equal(fs.existsSync(unallocated), true);
  fs.rmdirSync(unallocated);
  const controlMode = fs.lstatSync(control).mode & 0o777;
  const fileMode = fs.lstatSync(controlFile).mode & 0o777;
  assert.doesNotThrow(() => finish(root, { control: "read-only nested cleanup" }));
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.readFileSync(controlFile, "utf8"), "control bytes");
  assert.equal(fs.lstatSync(control).mode & 0o777, controlMode);
  assert.equal(fs.lstatSync(controlFile).mode & 0o777, fileMode);
  finish(control, { control: "linked target preserved" });
});

test("private external project reaches real preparation while protected code remains refused", { skip: process.platform === "win32" }, () => {
  const root = fixture();
  const preload = fileURLToPath(new URL("./_runner-preload.js", import.meta.url));
  const driver = fileURLToPath(new URL("./_managed-driver.js", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: "prepare" },
  });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(fs.readFileSync(path.join(root, "managed-info.json"), "utf8")) as
    { manifest: string; project: string };
  assert.equal(info.project, path.join(root, "project"));
  assert.equal(fs.existsSync(info.manifest), true);
  const protectedRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  assert.throws(() => prepareWorkerSandbox(
    { version: 1, task: "1233", sid: "control", read: [protectedRoot], write: [protectedRoot], domains: [] },
    "codex", root, ["/usr/bin/codex"], path.join(root, "guard-stage"), root),
    /SANDBOX_POLICY_CONTROL_OVERLAP/);
  finish(root, { controls: "external prepare and protected-root overlap" });
});

test("fake SRT chooses the supported platform grammar and real overlay guard accepts the host shape", async () => {
  const manifestEnv = { HOME: "/fixture/home", TMPDIR: "/fixture/tmp" };
  const darwin = fixtureSrtWrapper("darwin", manifestEnv);
  const linux = fixtureSrtWrapper("linux", manifestEnv);
  assert.match(darwin.argv[2]!, /^env SANDBOX_RUNTIME=1 .* \/usr\/bin\/sandbox-exec /);
  assert.match(linux.argv[2]!, /^bwrap --setenv SANDBOX_RUNTIME 1 /);
  assert.deepEqual(darwin.env, manifestEnv);
  assert.deepEqual(linux.env, manifestEnv);
  assert.throws(() => fixtureSrtWrapper("win32", manifestEnv), /R2_FAKE_SRT_PLATFORM_UNSUPPORTED/);
  for (const [platform, wrapper] of [["darwin", darwin], ["linux", linux]] as const) {
    assert.doesNotThrow(() => assertFixtureSrtSpawn(wrapper.argv[0]!, wrapper.argv.slice(1), platform));
    assert.throws(() => assertFixtureSrtSpawn(wrapper.argv[0]!, ["-c", wrapper.argv[2]! + " extra"], platform),
      /R2_FAKE_SRT_WRAPPER_REFUSED/);
    assert.throws(() => assertFixtureSrtSpawn(wrapper.argv[0]!, ["-c", wrapper.argv[2]!, "extra"], platform),
      /R2_FAKE_SRT_WRAPPER_REFUSED/);
    assert.throws(() => assertFixtureSrtSpawn("/usr/bin/sandbox-exec", wrapper.argv.slice(1), platform),
      /R2_FAKE_SRT_WRAPPER_REFUSED/);
  }
  assert.throws(() => assertFixtureSrtSpawn(linux.argv[0]!, linux.argv.slice(1), "darwin"),
    /R2_FAKE_SRT_WRAPPER_REFUSED/);
  assert.throws(() => assertFixtureSrtSpawn(darwin.argv[0]!, darwin.argv.slice(1), "win32"),
    /R2_FAKE_SRT_PLATFORM_UNSUPPORTED/);
  const loaded = await load("r2-fixture:srt", {}, async () => { throw new Error("unexpected loader fallback"); }) as
    { source: string };
  assert.match(loaded.source, /fixtureSrtWrapper\(process\.platform, process\.env\)/);
  if (process.platform === "darwin" || process.platform === "linux") {
    const runtimeRoot = path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"));
    assert.doesNotThrow(() => assertRuntimeOverlaySupported(runtimeRoot,
      process.platform === "darwin" ? darwin : linux, manifestEnv));
  }
});

test("runner preload resolves SRT from the candidate before the real overlay guard", () => {
  const root = fixture();
  try {
    const preload = fileURLToPath(new URL("./_runner-preload.js", import.meta.url));
    const driver = fileURLToPath(new URL("./_managed-driver.js", import.meta.url));
    const runnerUrl = new URL("../../../src/session/worker-sandbox-runner.js", import.meta.url).href;
    const expected = fileURLToPath(new URL(
      "../../../../node_modules/@anthropic-ai/sandbox-runtime/package.json", import.meta.url));
    assert.equal(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"),
      expected, "fixture control must resolve the candidate-owned SRT");
    const env = { ...childEnv(root), USERPROFILE: root, XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root, XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root,
      R2_FIXTURE_ROOT: root };
    const prepared = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, cwd: root,
      stdio: ["ignore", "pipe", "pipe"], env: { ...env, R2_MODE: "prepare" },
    });
    assert.ifError(prepared.error);
    assert.equal(prepared.status, 0, prepared.stderr);
    // Resolve from the real runner's module context without importing or launching it.
    const program = 'import { createRequire } from "node:module";\n' +
      'process.stdout.write(JSON.stringify(createRequire(process.argv[1]).resolve("@anthropic-ai/sandbox-runtime/package.json")) + "\\n");\n';
    const resolved = spawnSync(process.execPath,
      ["--import", preload, "--input-type=module", "-e", program, runnerUrl], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, cwd: root,
        stdio: ["ignore", "pipe", "pipe"], env: { ...env, R2_MODE: "runner" },
      });
    assert.ifError(resolved.error);
    assert.equal(resolved.status, 0, resolved.stderr);
    const actual: unknown = JSON.parse(resolved.stdout);
    // Never open, stat or canonicalize a mismatched result (including the author's host path).
    assert.equal(actual, expected, "runner preload must resolve the candidate-owned SRT");
    const manifestEnv = { HOME: root, TMPDIR: path.join(root, "tmp") };
    assert.doesNotThrow(() => assertRuntimeOverlaySupported(path.dirname(expected),
      fixtureSrtWrapper(process.platform, manifestEnv), manifestEnv));
  } finally {
    finish(root, { controls: "candidate SRT resolution before real version/source-hash guard" });
  }
});
