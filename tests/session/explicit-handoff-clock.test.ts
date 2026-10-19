import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A child loads a copy of the real compiled import closure after installing controlled
// Node clocks. Its home, executable and input are private fixture values; no provider runs.
const driver = String.raw`
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const os = require("node:os");
const root = process.argv[1], scenario = process.argv[2];
const moduleAt = (p) => import(pathToFileURL(path.join(root, "dist", "src", p)).href);
const { nativeMaintenanceProof } = await moduleAt("environment/native-boot.js");
nativeMaintenanceProof.bootIdentity = () => null;
const { upgradeConfig, controllerContext, inspectGrants } = await moduleAt("environment/grants.js");
const { OwnedInput } = await moduleAt("environment/owned-input.js");
const { prepareExplicitClaudeHandoff: prepare, claimExplicitClaudeHandoff: claim } =
  await moduleAt("session/claude-worker-oauth.js");
const home = fs.realpathSync(fs.mkdtempSync(path.join(root, "home-")));
upgradeConfig(home, 0);
const ctx = controllerContext(home), sid = "clock-fixture";
const cli = path.join(home, "claude");
fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
const st = fs.statSync(cli);
const executable = { cli: "claude", path: cli, realpath: cli, dev: st.dev, ino: st.ino,
  size: st.size, mtimeMs: st.mtimeMs, version: null, versionSource: "unknown" };
const fake = "FAKE-EXPLICIT-CLOCK-TOKEN";
const origin = 1_700_000_000_000, bootSeconds = 100_000;
function clock(now, uptime) {
  Date.now = typeof now === "function" ? now : () => now;
  os.uptime = typeof uptime === "function" ? uptime : () => uptime;
  syncBuiltinESMExports();
}
const denied = () => { throw new Error("private native clock detail"); };
function paths(attempt) {
  const count = path.join(home, "environment", "explicit-receipts", attempt);
  const dir = path.join(home, "sessions", sid, "explicit-handoffs", attempt);
  const pointer = path.join(home, "sessions", sid, "explicit-current.json");
  return { count, dir, pointer, temporary: pointer + "." + attempt + ".tmp" };
}
function issue(attempt = randomUUID()) {
  const input = OwnedInput.fromBytes(Buffer.from(fake));
  const ref = prepare(ctx, input, { sid, attempt, executable, command: [cli, "--model", "fixture"] });
  assert.throws(() => input.consume(), /ENV_INPUT_CONSUMED/);
  return ref;
}
function refusePrepare(attempt, previousPointer = null) {
  const input = OwnedInput.fromBytes(Buffer.from(fake));
  const p = paths(attempt), before = inspectGrants(ctx).total;
  assert.throws(() => prepare(ctx, input, { sid, attempt, executable, command: [cli] }),
    (e) => e instanceof Error && e.message === "ENV_GRANT_CLOCK_UNCERTAIN");
  assert.throws(() => input.consume(), /ENV_INPUT_CONSUMED/);
  assert.equal(inspectGrants(ctx).total, before);
  for (const file of [p.count, p.dir, p.temporary]) assert.equal(fs.existsSync(file), false);
  if (previousPointer === null) assert.equal(fs.existsSync(p.pointer), false);
  else assert.deepEqual(fs.readFileSync(p.pointer), previousPointer);
}
function refuseClaim(ref, expected) {
  const dir = path.dirname(ref.receipt);
  assert.throws(() => claim(ctx, ref.receipt),
    (e) => e instanceof Error && e.message === expected);
  assert.equal(fs.existsSync(path.join(dir, "spent.json")), false);
  assert.ok(fs.readFileSync(path.join(dir, "token"), "utf8") === fake + "\n");
}
clock(origin, bootSeconds);
if (scenario === "denied-prepare") {
  clock(origin, denied);
  refusePrepare(randomUUID());
} else if (scenario === "existing-pointer") {
  const valid = issue();
  const pointer = fs.readFileSync(paths(valid.attempt).pointer);
  clock(origin, denied);
  refusePrepare(randomUUID(), pointer);
  assert.equal(fs.existsSync(valid.receipt), true);
  assert.ok(fs.readFileSync(path.join(path.dirname(valid.receipt), "token"), "utf8") === fake + "\n");
} else if (scenario === "invalid-preparation") {
  const bad = [
    [denied, bootSeconds], [origin, denied], [NaN, bootSeconds], [Infinity, bootSeconds],
    [-1, bootSeconds], [origin, -1], [origin, Infinity],
    [Number.MAX_SAFE_INTEGER - 299_999, bootSeconds],
    [origin, Number.MAX_SAFE_INTEGER / 1000 + 1], [1, bootSeconds],
  ];
  for (const [now, uptime] of bad) {
    clock(now, uptime);
    refusePrepare(randomUUID());
  }
} else if (scenario === "denied-claim") {
  const ref = issue(), dir = path.dirname(ref.receipt);
  clock(origin, denied);
  refuseClaim(ref, "ENV_GRANT_CLOCK_UNCERTAIN");
  assert.equal(fs.existsSync(path.join(dir, "token")), true);
  clock(origin, bootSeconds);
  const received = claim(ctx, ref.receipt);
  assert.ok(received.env.CLAUDE_CODE_OAUTH_TOKEN === fake);
  assert.deepEqual(received.command, [cli, "--model", "fixture"]);
  assert.equal(fs.existsSync(path.join(dir, "token")), false);
  assert.throws(() => claim(ctx, ref.receipt), /ENV_GRANT_SPENT/);
} else if (scenario === "expiry-rollback") {
  let ref = issue();
  clock(origin - 1, bootSeconds);
  refuseClaim(ref, "ENV_GRANT_CLOCK_UNCERTAIN");
  clock(origin + 1001, bootSeconds);
  refuseClaim(ref, "ENV_GRANT_CLOCK_UNCERTAIN");
  clock(origin + 300_000, bootSeconds + 300);
  refuseClaim(ref, "ENV_GRANT_EXPIRED");
  clock(origin, bootSeconds);
  ref = issue();
  clock(origin + 299_000, bootSeconds + 300);
  refuseClaim(ref, "ENV_GRANT_EXPIRED");
  clock(origin, bootSeconds);
  ref = issue();
  clock(origin + 1000, bootSeconds);
  const received = claim(ctx, ref.receipt);
  assert.ok(received.env.CLAUDE_CODE_OAUTH_TOKEN === fake);
} else {
  throw new Error("unknown fixture scenario");
}
`;

const sourceRoot = resolve(import.meta.dirname, "..", "..", "..");
for (const scenario of ["denied-prepare", "existing-pointer", "invalid-preparation", "denied-claim", "expiry-rollback"]) {
  test(`explicit handoff clock: ${scenario}`, { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "explicit-clock-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      cpSync(join(sourceRoot, "dist", "src"), join(root, "dist", "src"), { recursive: true });
      mkdirSync(join(root, "bin", "lib"), { recursive: true });
      for (const module of ["executable-version.mjs", "win-private-storage.mjs"]) {
        copyFileSync(join(sourceRoot, "bin", "lib", module), join(root, "bin", "lib", module));
      }
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", driver, root, scenario],
        { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "" } });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(result.stdout, "");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
