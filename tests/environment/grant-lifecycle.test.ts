import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { abortGrant, controllerContext, inspectGrants, reapExpired, reclaimGrants, rotateGrants, upgradeConfig } from "../../src/environment/grants.js";
import { readConfig, recoverWriterLock } from "../../src/environment/storage.js";
import type { MaintenanceProofAdapter } from "../../src/environment/native-boot.js";
import { OwnedInput } from "../../src/environment/owned-input.js";
import { claimExplicitClaudeHandoff, prepareExplicitClaudeHandoff } from "../../src/session/claude-worker-oauth.js";

test("explicit generation rotation is revisioned and does not silently issue a grant", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-grants-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home);
    assert.equal(inspectGrants(ctx).total, 0);
    assert.throws(() => rotateGrants(ctx, 0, 1), /ENV_REVISION_CONFLICT/);
    const rotated = rotateGrants(ctx, 1, 1);
    assert.equal(rotated.authorityGeneration, 2);
    assert.equal(rotated.revision, 2);
    assert.equal(reclaimGrants(ctx, 2, 2, 128), 0);
    assert.equal(readConfig(home).version, 2);
    assert.throws(() => rotateGrants(ctx, 2, 1), /ENV_REVISION_CONFLICT/);
    assert.throws(() => reclaimGrants(ctx, 2, 2, 129), /ENV_SCHEMA_BOUND/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const OLD_BOOT = "00000000-0000-4000-8000-000000000001";
const NEW_BOOT = "00000000-0000-4000-8000-000000000002";
const proof = (offline: boolean): MaintenanceProofAdapter => ({
  bootIdentity: () => NEW_BOOT, offlineQuiescence: () => offline,
});
function lockFixture(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-recover-")));
  fs.mkdirSync(path.join(home, "environment"), { mode: 0o700 });
  return home;
}
test("older-boot owner is journaled; same-boot and empty locks require offline proof", { skip: process.platform === "win32" }, () => {
  for (const owner of [OLD_BOOT, NEW_BOOT, null]) {
    const home = lockFixture(), lock = path.join(home, "environment", "writer.lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      if (owner) fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ version: 1,
        nonce: randomUUID(), boot: owner }) + "\n", { mode: 0o600 });
      if (owner === OLD_BOOT) {
        assert.equal(recoverWriterLock(home, proof(false)), true);
        assert.equal(fs.existsSync(lock), false);
      } else {
        assert.throws(() => recoverWriterLock(home, proof(false)), /ENV_WRITER_LOCKED/);
        assert.equal(fs.existsSync(lock), true);
        assert.equal(recoverWriterLock(home, proof(true)), true);
      }
      assert.equal(fs.existsSync(path.join(home, "environment", "maintenance.guard")), false);
      assert.equal(fs.existsSync(path.join(home, "environment", "maintenance-journal")), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test("interrupted maintenance resumes only the pinned lock identity", { skip: process.platform === "win32" }, () => {
  const home = lockFixture(), parent = path.join(home, "environment");
  const lock = path.join(parent, "writer.lock"), journal = path.join(parent, "maintenance-journal");
  const guard = path.join(parent, "maintenance.guard"), nonce = randomUUID();
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ version: 1, nonce, boot: OLD_BOOT }) + "\n", { mode: 0o600 });
    const st = fs.lstatSync(lock);
    fs.mkdirSync(guard, { mode: 0o700 });
    fs.mkdirSync(journal, { mode: 0o700 });
    for (const dir of [guard, journal]) fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({
      version: 1, nonce: randomUUID(), boot: NEW_BOOT }) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(journal, "pin.json"), JSON.stringify({ version: 1,
      dev: String(st.dev), ino: String(st.ino), ownerNonce: nonce }) + "\n", { mode: 0o600 });
    fs.renameSync(lock, path.join(journal, "writer.lock"));
    assert.throws(() => recoverWriterLock(home, proof(false)), /ENV_WRITER_LOCKED/);
    assert.equal(recoverWriterLock(home, proof(true)), true);
    assert.equal(fs.existsSync(journal), false);
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ version: 1,
      nonce: randomUUID(), boot: OLD_BOOT }) + "\n", { mode: 0o600 });
    fs.mkdirSync(journal, { mode: 0o700 });
    fs.writeFileSync(path.join(journal, "owner.json"), JSON.stringify({ version: 1,
      nonce: randomUUID(), boot: OLD_BOOT }) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(journal, "pin.json"), JSON.stringify({ version: 1,
      dev: String(st.dev), ino: String(st.ino), ownerNonce: nonce }) + "\n", { mode: 0o600 });
    assert.throws(() => recoverWriterLock(home, proof(true)), /ENV_MAINTENANCE_INCOMPLETE/);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("ownerless pinned journal resumes offline but rejects an owner inserted after detach", { skip: process.platform === "win32" }, () => {
  const home = lockFixture(), parent = path.join(home, "environment");
  const lock = path.join(parent, "writer.lock"), guard = path.join(parent, "maintenance.guard");
  const journal = path.join(parent, "maintenance-journal"), moved = path.join(journal, "writer.lock");
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    const identity = fs.lstatSync(lock);
    for (const dir of [guard, journal]) {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ version: 1,
        nonce: randomUUID(), boot: OLD_BOOT }) + "\n", { mode: 0o600 });
    }
    fs.writeFileSync(path.join(journal, "pin.json"), JSON.stringify({ version: 1,
      dev: String(identity.dev), ino: String(identity.ino), ownerNonce: null }) + "\n", { mode: 0o600 });
    fs.renameSync(lock, moved);
    fs.writeFileSync(path.join(moved, "owner.json"), JSON.stringify({ version: 1,
      nonce: randomUUID(), boot: OLD_BOOT }) + "\n", { mode: 0o600 });
    assert.throws(() => recoverWriterLock(home, proof(true)), /ENV_MAINTENANCE_INCOMPLETE/);
    fs.unlinkSync(path.join(moved, "owner.json"));
    assert.equal(recoverWriterLock(home, proof(true)), true);
    assert.equal(fs.existsSync(guard), false);
    assert.equal(fs.existsSync(journal), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("combined physical count remains full until bounded old-generation reclaim", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-physical-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home), counted = path.join(home, "environment", "explicit-receipts");
    fs.mkdirSync(counted, { mode: 0o700 });
    for (let i = 0; i < 1024; i++) {
      const attempt = randomUUID(), dir = path.join(counted, attempt);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ version: 1,
        controllerRootId: ctx.rootId, authorityGeneration: 1, sid: "fixture-sid", attempt }) + "\n", { mode: 0o600 });
    }
    assert.equal(inspectGrants(ctx).total, 1024);
    const rotated = rotateGrants(ctx, 1, 1);
    assert.equal(rotated.retiredRecords, 1024);
    assert.equal(inspectGrants(ctx).total, 1024);
    assert.equal(reclaimGrants(ctx, 2, 2, 128), 128);
    assert.equal(inspectGrants(ctx).total, 896);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("uncertain current-generation grant is terminalized before same-generation reclaim", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-reap-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home), id = randomUUID(), attempt = randomUUID();
    const dir = path.join(home, "environment", "grants", id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const grant = { version: 1, grantId: id, controllerRootId: ctx.rootId, authorityGeneration: 1,
      task: "fixture", sid: "fixture-sid", attempt, consumerId: "claude-confined-worker",
      executableBinding: {}, projectEnrollmentId: randomUUID(), targetRootIdentity: { dev: "1", ino: "2" },
      configRevision: 1, bindingId: randomUUID(), bindingEpoch: 1, projectEpoch: 1,
      destinationId: "claude-code-oauth-env", issuedAt: now - 360_000, expiresAt: now - 60_000 };
    const prepared = { version: 1, grantId: id, controllerRootId: ctx.rootId, authorityGeneration: 1,
      task: "fixture", sid: "fixture-sid", attempt, manifestSha256: "0".repeat(64),
      scope: { version: 1, task: "fixture", sid: "fixture-sid", read: [], write: [], domains: [] },
      payloadPath: path.join(home, "sessions", "fixture-sid", "sandbox", attempt, "claude-oauth", "token"),
      preparedAt: now - 360_000, clock: { issuedUptimeMs: 0, bootEstimateEpochMs: 0 } };
    fs.writeFileSync(path.join(dir, "grant.json"), JSON.stringify(grant) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "prepared.json"), JSON.stringify(prepared) + "\n", { mode: 0o600 });
    assert.equal(reapExpired(ctx, 1), 1);
    assert.equal(fs.existsSync(path.join(dir, "terminal.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "prepared.json")), false);
    assert.equal(abortGrant(ctx, id), false);
    assert.equal(reclaimGrants(ctx, 1, 1, 1), 1);
    assert.equal(inspectGrants(ctx).total, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("explicit claim refuses a missing protected receipt record before spend", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-explicit-record-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home), cli = path.join(home, "claude");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const st = fs.statSync(cli), attempt = randomUUID();
    const executable = { cli: "claude" as const, path: cli, realpath: cli, dev: st.dev, ino: st.ino,
      size: st.size, mtimeMs: st.mtimeMs, version: null, versionSource: "unknown" as const };
    const ref = prepareExplicitClaudeHandoff(ctx, OwnedInput.fromBytes(Buffer.from("fixture-token")), {
      sid: "fixture-sid", attempt, executable, command: [cli],
    });
    const counted = path.join(home, "environment", "explicit-receipts", attempt, "record.json");
    fs.unlinkSync(counted);
    assert.throws(() => claimExplicitClaudeHandoff(ctx, ref.receipt), /ENV_GRANT_INVALID/);
    assert.equal(fs.existsSync(path.join(path.dirname(ref.receipt), "spent.json")), false);
    assert.equal(fs.existsSync(path.join(path.dirname(ref.receipt), "token")), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("reclaim refuses a symlinked session stage before deleting its counted record", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-stage-parent-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home), attempt = randomUUID();
    const counted = path.join(home, "environment", "explicit-receipts", attempt);
    fs.mkdirSync(counted, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(counted, "record.json"), JSON.stringify({ version: 1,
      controllerRootId: ctx.rootId, authorityGeneration: 1, sid: "fixture-sid", attempt }) + "\n", { mode: 0o600 });
    const sessions = path.join(home, "sessions");
    fs.mkdirSync(sessions, { mode: 0o700 });
    fs.symlinkSync(home, path.join(sessions, "fixture-sid"));
    rotateGrants(ctx, 1, 1);
    assert.throws(() => reclaimGrants(ctx, 2, 2, 1), /ENV_UNSAFE_PATH/);
    assert.equal(fs.existsSync(path.join(counted, "record.json")), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("unverifiable empty writer lock refuses a rotation", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-lock-")));
  try {
    upgradeConfig(home, 0);
    fs.mkdirSync(path.join(home, "environment", "writer.lock"), { mode: 0o700 });
    assert.throws(() => rotateGrants(controllerContext(home), 1, 1), /ENV_WRITER_LOCKED/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("injected maintenance interruption leaves a guard and needs offline proof to resume", { skip: process.platform === "win32" }, () => {
  for (const interruptAt of [2, 3]) {
    const home = lockFixture(), parent = path.join(home, "environment"), lock = path.join(parent, "writer.lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ version: 1,
        nonce: randomUUID(), boot: OLD_BOOT }) + "\n", { mode: 0o600 });
      let reads = 0;
      const interrupted: MaintenanceProofAdapter = {
        bootIdentity: () => { if (++reads === interruptAt) throw new Error("INJECTED_BOOT_PROOF_FAILURE"); return NEW_BOOT; },
        offlineQuiescence: () => false,
      };
      assert.throws(() => recoverWriterLock(home, interrupted), /INJECTED_BOOT_PROOF_FAILURE/);
      assert.equal(fs.existsSync(path.join(parent, "maintenance.guard")), true);
      assert.throws(() => recoverWriterLock(home, proof(false)), /ENV_WRITER_LOCKED/);
      if (interruptAt === 3) {
        assert.throws(() => recoverWriterLock(home, proof(true)), /ENV_MAINTENANCE_RETRY_REQUIRED/);
      }
      assert.equal(recoverWriterLock(home, proof(true)), true);
      assert.equal(fs.existsSync(lock), false);
      assert.equal(fs.existsSync(path.join(parent, "maintenance.guard")), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test("explicit protected record forgery and competing publication cannot spend the older attempt", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-explicit-race-")));
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home), cli = path.join(home, "claude");
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const st = fs.statSync(cli);
    const executable = { cli: "claude" as const, path: cli, realpath: cli, dev: st.dev, ino: st.ino,
      size: st.size, mtimeMs: st.mtimeMs, version: null, versionSource: "unknown" as const };
    const first = prepareExplicitClaudeHandoff(ctx, OwnedInput.fromBytes(Buffer.from("fixture-first")), {
      sid: "fixture-sid", attempt: randomUUID(), executable, command: [cli],
    });
    const record = path.join(home, "environment", "explicit-receipts", first.attempt, "record.json");
    const original = fs.readFileSync(record);
    const forged = JSON.parse(original.toString()) as Record<string, unknown>;
    forged.controllerRootId = randomUUID();
    fs.writeFileSync(record, JSON.stringify(forged) + "\n", { mode: 0o600 });
    assert.throws(() => claimExplicitClaudeHandoff(ctx, first.receipt), /ENV_GRANT_INVALID/);
    assert.equal(fs.existsSync(path.join(path.dirname(first.receipt), "spent.json")), false);
    fs.writeFileSync(record, original, { mode: 0o600 });
    const second = prepareExplicitClaudeHandoff(ctx, OwnedInput.fromBytes(Buffer.from("fixture-second")), {
      sid: "fixture-sid", attempt: randomUUID(), executable, command: [cli],
    });
    assert.throws(() => claimExplicitClaudeHandoff(ctx, first.receipt), /ENV_GRANT_INVALID/);
    assert.equal(fs.existsSync(path.join(path.dirname(first.receipt), "spent.json")), false);
    const winner = claimExplicitClaudeHandoff(ctx, second.receipt);
    assert.equal(winner.env.CLAUDE_CODE_OAUTH_TOKEN, "fixture-second");
    assert.throws(() => claimExplicitClaudeHandoff(ctx, second.receipt), /ENV_GRANT_SPENT/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
