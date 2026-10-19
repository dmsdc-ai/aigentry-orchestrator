import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { recoverWriterLock } from "../../../src/environment/storage.js";
import { controllerContext, upgradeConfig, rotateGrants } from "../../../src/environment/grants.js";
import type { MaintenanceProofAdapter } from "../../../src/environment/native-boot.js";
import { finish, fixture, snapshot } from "./fixture.js";

const oldBoot = "00000000-0000-4000-8000-000000000001";
const newBoot = "00000000-0000-4000-8000-000000000002";

test("interrupted writer recovery retains uncertain authority until explicit offline proof", { skip: process.platform === "win32" }, () => {
  const home = fixture();
  fs.mkdirSync(path.join(home, "environment"), { mode: 0o700 });
  const lock = path.join(home, "environment", "writer.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ version: 1, nonce: randomUUID(), boot: oldBoot }) + "\n",
    { flag: "wx", mode: 0o600 });
  let calls = 0;
  const fault: MaintenanceProofAdapter = { bootIdentity: () => {
    if (++calls === 2) throw new Error("FIXTURE_PROOF_INTERRUPTED");
    return newBoot;
  }, offlineQuiescence: () => false };
  assert.throws(() => recoverWriterLock(home, fault), /FIXTURE_PROOF_INTERRUPTED/);
  assert.equal(fs.existsSync(path.join(home, "environment", "maintenance.guard")), true);
  const noProof: MaintenanceProofAdapter = { bootIdentity: () => newBoot, offlineQuiescence: () => false };
  assert.throws(() => recoverWriterLock(home, noProof), /ENV_WRITER_LOCKED/);
  snapshot(home, "uncertain-before-recovery", { lock: fs.existsSync(lock), guard: true, replacedBoundary: "bootIdentity call 2" });
  const proof: MaintenanceProofAdapter = { bootIdentity: () => newBoot, offlineQuiescence: () => true };
  assert.equal(recoverWriterLock(home, proof), true);
  assert.equal(fs.existsSync(lock), false);
  finish(home, { recovered: true, proof: "explicit fake offlineQuiescence; native proof unmeasured" });
});

test("generation rotation keeps an uncertain grant directory counted and replay authority retired", { skip: process.platform === "win32" }, () => {
  const home = fixture();
  upgradeConfig(home, 0);
  const ctx = controllerContext(home), id = randomUUID(), dir = path.join(home, "environment", "grants", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = rotateGrants(ctx, 1, 1);
  assert.equal(before.authorityGeneration, 2);
  assert.equal(fs.existsSync(dir), true);
  assert.throws(() => rotateGrants(ctx, 1, 1), /ENV_REVISION_CONFLICT/);
  finish(home, { revision: before.revision, grantDirectoryRetained: fs.existsSync(dir) });
});
