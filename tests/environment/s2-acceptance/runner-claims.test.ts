import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv, finish, fixture, invokeNode } from "./fixture.js";

const runner = fileURLToPath(new URL("../../../src/session/worker-sandbox-runner.js", import.meta.url));
const preload = fileURLToPath(new URL("./_runner-preload.js", import.meta.url));
const driver = fileURLToPath(new URL("./_managed-driver.js", import.meta.url));
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

interface ManagedInfo { manifest: string; hash: string; grantId: string; attempt: string; central: string; sid: string }
function managedEnv(root: string, mode: "prepare" | "runner" | "revoke", extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: mode, ...extra };
}
function prepare(root: string): ManagedInfo {
  const result = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
    encoding: "utf8", timeout: 30_000, env: managedEnv(root, "prepare"),
  });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(fs.readFileSync(path.join(root, "managed-info.json"), "utf8")) as ManagedInfo;
  assert.equal((JSON.parse(result.stdout) as { hash: string }).hash, info.hash);
  assert.equal(fs.existsSync(path.join(info.central, "sessions", info.sid, "sandbox", info.attempt, "manifest.json")), true);
  return info;
}
function runManaged(root: string, info: ManagedInfo, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", preload, runner, info.manifest, info.hash], {
    encoding: "utf8", timeout: 30_000, env: managedEnv(root, "runner", extra),
  });
}
function providerRecords(root: string): Array<{ selected: boolean; other: boolean; argv: string[]; fd3: boolean }> {
  return fs.readdirSync(root).filter(name => /^provider-[0-9]+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as {
      selected: boolean; other: boolean; argv: string[]; fd3: boolean });
}

test("real prepare and runner deliver one selected credential to the owned provider, then spent replay refuses", { skip: process.platform === "win32" }, () => {
  const root = fixture(), info = prepare(root);
  const result = runManaged(root, info);
  assert.equal(result.status, 0, result.stderr);
  const records = providerRecords(root);
  assert.equal(records.length, 1, result.stderr);
  assert.equal(records[0]?.selected, true);
  assert.equal(records[0]?.other, false);
  assert.equal(records[0]?.fd3, false);
  assert.deepEqual(records[0]?.argv.slice(0, 4), ["--model", "fixture-model", "--effort", "high"]);
  const grant = path.join(info.central, "environment", "grants", info.grantId);
  assert.equal(fs.existsSync(path.join(grant, "spent.json")), true);
  assert.equal(fs.existsSync(path.join(info.central, "sessions", info.sid, "sandbox", info.attempt, "claude-oauth", "token")), false);
  const replay = runManaged(root, info);
  assert.equal(replay.status, 78, replay.stderr);
  assert.match(replay.stderr, /ENV_GRANT_SPENT/);
  assert.equal(providerRecords(root).length, 1);
  finish(root, { result: result.status, replay: replay.status, selectedRecipients: records.length,
    mocked: ["native boot proof", "os.userInfo", "SRT module", "preflight process", "SRT wrapper spawn"] });
});

test("two runner processes meet at the pre-writer-lock barrier and only one provider starts", { skip: process.platform === "win32", timeout: 35_000 }, async () => {
  const root = fixture(), info = prepare(root);
  const children = [0, 1].map(() => spawn(process.execPath, ["--import", preload, runner, info.manifest, info.hash], {
    env: managedEnv(root, "runner", { R2_BARRIER: "race" }), stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }));
  const closed = children.map(child => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", data => { stderr += String(data); });
    child.once("error", reject); child.once("close", code => resolve({ code, stderr }));
  }));
  const deadline = process.hrtime.bigint() + 15_000_000_000n;
  while (fs.readdirSync(root).filter(name => /^ready-[0-9]+$/.test(name)).length < 2) {
    if (children.some(child => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("R2_RUNNER_EXITED_BEFORE_BARRIER");
    }
    if (process.hrtime.bigint() > deadline) throw new Error("R2_BARRIER_TIMEOUT");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  fs.writeFileSync(path.join(root, "release"), "release\n", { flag: "wx", mode: 0o600 });
  const results = await Promise.all(closed);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 78], results.map(r => r.stderr).join("\n"));
  assert.equal(providerRecords(root).length, 1);
  assert.equal(providerRecords(root)[0]?.selected, true);
  assert.equal(fs.existsSync(path.join(info.central, "environment", "grants", info.grantId, "spent.json")), true);
  finish(root, { codes: results.map(r => r.code), readyCount: 2, providerCount: 1 });
});

test("actual claim refuses revoked binding, exact expiry and monotonic rollback without provider spawn", { skip: process.platform === "win32" }, () => {
  for (const caseName of ["revoke", "expiry", "rollback"] as const) {
    const root = fixture(), info = prepare(root);
    if (caseName === "revoke") {
      const mutation = spawnSync(process.execPath, ["--import", preload, driver, "revoke"], {
        encoding: "utf8", timeout: 15_000, env: managedEnv(root, "revoke"),
      });
      assert.equal(mutation.status, 0, mutation.stderr);
    }
    const result = runManaged(root, info, caseName === "revoke" ? {} : { R2_CLOCK: caseName });
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, caseName === "revoke" ? /ENV_GRANT_REVOKED/ : /ENV_GRANT_EXPIRED|ENV_GRANT_CLOCK_UNCERTAIN/);
    assert.equal(providerRecords(root).length, 0);
    assert.equal(fs.existsSync(path.join(info.central, "environment", "grants", info.grantId, "spent.json")), false);
    finish(root, { caseName, status: result.status, providerCount: 0 });
  }
});

test("actual runner rejects copied and forged stage records before wrapper spawn", { skip: process.platform === "win32" }, () => {
  for (const alteration of ["unknown-version", "extra-key", "duplicate-key", "copied-stage", "wrong-hash"] as const) {
    const home = fixture(), sid = "fixture-sid", attempt = randomUUID();
    const stage = path.join(home, "sessions", sid, "sandbox", attempt);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const file = path.join(stage, "manifest.json");
    const provider = path.join(home, "provider-recorder");
    const marker = path.join(home, "provider-spawned");
    fs.writeFileSync(provider, `#!/bin/sh\n: > '${marker}'\n`, { flag: "wx", mode: 0o700 });
    const manifest = { version: alteration === "unknown-version" ? 9 : 1, task: "fixture-task", sid, attempt,
      cli: "claude", cwd: home, command: [provider], env: {}, config: {},
      probeFile: path.join(stage, "outside-canary.txt"),
      probeDirectory: path.join(stage, "outside-directory-canary"), receipt: path.join(stage, "receipt.json"),
      ...(alteration === "extra-key" ? { grantArtifact: "forged" } : {}) };
    let raw = JSON.stringify(manifest);
    if (alteration === "duplicate-key") raw = raw.replace('"version":1', '"version":1,"version":1');
    fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
    const nominated = alteration === "copied-stage" ? path.join(home, "copied", "manifest.json") : file;
    if (alteration === "copied-stage") {
      fs.mkdirSync(path.dirname(nominated), { mode: 0o700 });
      fs.copyFileSync(file, nominated);
    }
    const result = invokeNode(runner, [nominated, alteration === "wrong-hash" ? "0".repeat(64) : hash(raw)], home);
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /SANDBOX_MANIFEST_INVALID|SANDBOX_MANIFEST_CHANGED/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(stage, "receipt.json")), false);
    finish(home, { alteration, status: result.status, stderr: result.stderr });
  }
});
