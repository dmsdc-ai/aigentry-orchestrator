import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { environmentCommand } from "../../src/environment/cli.js";
import { configPath, mutateConfig, readConfig } from "../../src/environment/storage.js";

const posix = process.platform !== "win32";
const fixture = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-storage-")));
test("rejected setting/revision/profile input has no filesystem effect", () => {
  const base = fixture(), home = path.join(base, "absent");
  try {
    for (const args of [["set", "unknown", "fake", "--expected-revision", "0"], ["set", "claude.model", "bad\nvalue", "--expected-revision", "0"], ["set", "claude.model", "fixture-model"], ["profile", "select", "missing", "--expected-revision", "0"]]) {
      assert.equal(environmentCommand(args, { AIGENTRY_HOME: home }).code, 2);
      assert.equal(fs.existsSync(home), false);
    }
  } finally { fs.rmSync(base, { recursive: true }); }
});

test("private CAS writes preserve foreign legacy bytes and revisions; stale writer and unverifiable lock refuse", { skip: !posix }, () => {
  const home = fixture();
  try {
    const legacy = '{"roles":{},"foreign":{"keep":true}}\n'; fs.writeFileSync(path.join(home, "config.json"), legacy);
    mutateConfig(home, 0, (c) => { c.settings["claude.model"] = "fixture-model"; return c; });
    assert.equal(readConfig(home).revision, 1);
    assert.equal(fs.statSync(configPath(home)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(home, "config.json"), "utf8"), legacy);
    const before = fs.readFileSync(configPath(home));
    assert.throws(() => mutateConfig(home, 0, (c) => c), /REVISION_CONFLICT/);
    fs.mkdirSync(path.join(home, "environment/writer.lock"), { mode: 0o700 });
    assert.throws(() => mutateConfig(home, 1, (c) => c), /WRITER_LOCKED/);
    assert.deepEqual(fs.readFileSync(configPath(home)), before);
  } finally { fs.rmSync(home, { recursive: true }); }
});

test("opaque legacy conflicts reject the real mutator without creating central paths", { skip: !posix }, () => {
  const home = fixture();
  try {
    const legacy = '{"defaults":{"cli":"claude","cli_flags":"--model opaque-model"}}\n';
    fs.writeFileSync(path.join(home, "config.json"), legacy);
    const r = environmentCommand(["set", "claude.model", "fixture-model", "--expected-revision", "0"], { AIGENTRY_HOME: home });
    assert.equal(r.code, 2); assert.match(r.err, /LEGACY_FLAGS_CONFLICT/);
    assert.equal(fs.existsSync(path.join(home, "environment")), false);
    assert.equal(fs.readFileSync(path.join(home, "config.json"), "utf8"), legacy);
  } finally { fs.rmSync(home, { recursive: true }); }
});

test("symlink/hardlink/unsafe mode/FIFO and owner substitutions refuse without replacing targets", { skip: !posix }, () => {
  const base = fixture(), home = path.join(base, "home"); fs.mkdirSync(home, { mode: 0o700 });
  try {
    mutateConfig(home, 0, (c) => c);
    const destination = configPath(home), copy = path.join(base, "untouched");
    const bytes = fs.readFileSync(destination); fs.writeFileSync(copy, bytes, { mode: 0o600 });
    fs.unlinkSync(destination); fs.symlinkSync(copy, destination);
    assert.throws(() => readConfig(home), /UNSAFE_PATH/);
    fs.unlinkSync(destination); fs.linkSync(copy, destination);
    assert.throws(() => mutateConfig(home, 1, (c) => c), /UNSAFE_PATH/);
    fs.unlinkSync(destination); fs.writeFileSync(destination, bytes, { mode: 0o644 });
    assert.throws(() => readConfig(home), /UNSAFE_PATH/);
    fs.chmodSync(destination, 0o600);
    if (process.getuid?.() === 0) {
      fs.chownSync(destination, 1, 1);
      assert.throws(() => readConfig(home), /UNSAFE_PATH/);
      fs.chownSync(destination, 0, 0);
    }
    assert.deepEqual(fs.readFileSync(copy), bytes);
    fs.unlinkSync(destination);
    const fifo = spawnSync("mkfifo", [destination]); assert.equal(fifo.status, 0);
    assert.throws(() => readConfig(home), /UNSAFE_PATH/);
    fs.unlinkSync(destination); fs.writeFileSync(destination, bytes, { mode: 0o600 });
    fs.renameSync(path.join(home, "environment"), path.join(home, "saved"));
    fs.symlinkSync(path.join(home, "saved"), path.join(home, "environment"));
    assert.throws(() => readConfig(home), /UNSAFE_PATH/);
    const alias = path.join(base, "parent-alias"); fs.symlinkSync(home, alias);
    assert.throws(() => readConfig(path.join(alias, "absent")), /UNSAFE_PARENT/);
  } finally { fs.rmSync(base, { recursive: true }); }
});

test("profile selection, scoped project set/unset and central defaults are explicit revisioned commands", { skip: !posix }, () => {
  const home = fixture(), target = fixture(), env = { AIGENTRY_HOME: home };
  try {
    assert.equal(environmentCommand(["set", "claude.model", "fixture-profile", "--profile", "work", "--expected-revision", "0"], env).code, 0);
    assert.equal(environmentCommand(["profile", "select", "work", "--expected-revision", "1"], env).code, 0);
    const explained = environmentCommand(["explain", "claude.model"], env);
    assert.equal(JSON.parse(explained.out).source, "profile");
    assert.equal(environmentCommand(["set", "claude.model", "fixture-project", "--project", target, "--expected-revision", "2"], env).code, 0);
    assert.equal(environmentCommand(["unset", "claude.model", "--project", target, "--expected-revision", "3"], env).code, 0);
    assert.deepEqual(readConfig(home).projects[target], {});
    assert.equal(readConfig(home).revision, 4);
  } finally { fs.rmSync(home, { recursive: true }); fs.rmSync(target, { recursive: true }); }
});

test("two real package command processes with one expected revision cannot both commit", { skip: !posix }, async () => {
  const home = fixture();
  const cli = fileURLToPath(new URL("../../../bin/init/cli.mjs", import.meta.url));
  const writer = (model: string) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "env", "set", "claude.model", model, "--expected-revision", "0"], {
      env: { HOME: home, AIGENTRY_HOME: home, PATH: path.dirname(process.execPath) }, stdio: "pipe",
    });
    child.on("error", reject); child.on("close", (code) => resolve(code ?? -1));
  });
  try {
    const exits = await Promise.all([writer("fixture-model-a"), writer("fixture-model-b")]);
    assert.equal(exits.filter((code) => code === 0).length, 1);
    assert.equal(readConfig(home).revision, 1);
    assert.ok(["fixture-model-a", "fixture-model-b"].includes(readConfig(home).settings["claude.model"]!));
  } finally { fs.rmSync(home, { recursive: true }); }
});

test("Windows mutation refuses unavailable native ACL guarantees, while absent metadata is read-only", { skip: posix }, () => {
  const base = fixture(), home = path.join(base, "absent");
  try {
    assert.equal(environmentCommand(["doctor", "--json"], { AIGENTRY_HOME: home }).code, 0);
    const r = environmentCommand(["set", "claude.model", "fixture-model", "--expected-revision", "0"], { AIGENTRY_HOME: home });
    assert.match(r.err, /PROTECTION_UNAVAILABLE/);
    assert.equal(fs.existsSync(home), false);
  } finally { fs.rmSync(base, { recursive: true }); }
});
