import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSealedManifest } from "../../src/session/worker-sandbox.js";

type Json = Record<string, unknown>;
const privateTmp = resolve(process.env.TMPDIR ?? tmpdir());
const fixtureRoot = mkdtempSync(join(privateTmp, "sealed-model-"));
const sha256 = (raw: string): string => createHash("sha256").update(raw).digest("hex");
assert.equal(lstatSync(fixtureRoot).mode & 0o077, 0);
after(() => {
  assert.equal(lstatSync(fixtureRoot).isSymbolicLink(), false);
  rmSync(fixtureRoot, { recursive: true, force: false });
});

function fixture(version: 1 | 2, model: unknown): { manifest: string; hash: string; m: Json; root: string } {
  const attempt = randomUUID(), grantId = randomUUID();
  const controller = join(fixtureRoot, randomUUID());
  const stage = join(controller, "sessions", "fixture");
  const root = join(stage, "sandbox", attempt);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const executable = join(controller, "fake-cli", "claude");
  const m: Json = {
    version, task: "fixture-task", sid: "fixture", attempt, cli: "claude", cwd: controller,
    command: [executable, "--model", typeof model === "string" ? model : "fixture"], env: {},
    config: version === 2 ? {
      network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      allowPty: true, allowAppleEvents: false, enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
    } : {},
    probeFile: join(root, "outside-canary.txt"), probeDirectory: join(root, "outside-directory-canary"),
    receipt: join(root, "receipt.json"),
    launch: { v: 2, cli: "claude", model: { value: model, source: "default" },
      effort: { value: "high", source: "default" } },
  };
  if (version === 2) Object.assign(m, {
    controllerRootId: randomUUID(), authorityGeneration: 1,
    targetProject: { enrollmentId: randomUUID(), canonicalRoot: controller,
      identity: { dev: "1", ino: "2" }, epoch: 1 },
    delivery: { grantId, grantArtifact: join(controller, "environment", "grants", grantId, "grant.json") },
    launchPolicy: { kind: "managed-secret", restart: "never" },
    executable: { cli: "claude", path: executable, realpath: executable, dev: 1, ino: 2,
      size: 1, mtimeMs: 1, version: null, versionSource: "unknown" },
  });
  const manifest = join(root, "manifest.json");
  const hash = seal(manifest, m);
  return { manifest, hash, m, root };
}

function seal(manifest: string, m: Json): string {
  const raw = JSON.stringify(m) + "\n";
  writeFileSync(manifest, raw, { mode: 0o600, flag: "w" });
  chmodSync(manifest, 0o600);
  return sha256(raw);
}

function rejects(manifest: string, hash: string, code: string): void {
  assert.throws(() => readSealedManifest(manifest, hash), (error: unknown) =>
    error instanceof Error && error.message === code);
}

for (const version of [1, 2] as const) {
  test(`v${version}: old valid model reaches and passes sealed reader`, () => {
    const p = fixture(version, "claude-opus-5");
    assert.deepEqual(readSealedManifest(p.manifest, p.hash).m.launch?.model,
      { value: "claude-opus-5", source: "default" });
  });

  for (const model of ["claude-opus-5[1m]", `m${"x".repeat(199)}`]) {
    test(`v${version}: accepted model ${model.length} characters survives sealing`, () => {
      const p = fixture(version, model);
      const sealed = readSealedManifest(p.manifest, p.hash).m;
      assert.deepEqual(sealed.launch?.model,
        { value: model, source: "default" });
      assert.deepEqual(sealed.command, p.m.command);
      assert.equal(sealed.command[2], model);
    });
  }

  test(`v${version}: invalid model bounds and typed metadata refuse`, () => {
    for (const model of ["-leading", `m${"x".repeat(200)}`, 7]) {
      const p = fixture(version, model);
      rejects(p.manifest, p.hash, "AGENT_BINDING_MANIFEST");
    }
    for (const change of [
      (m: Json) => { (m.launch as Json).model = { value: "ok", source: "unknown" }; },
      (m: Json) => { (m.launch as Json).model = { value: "ok", source: "env:BAD" }; },
      (m: Json) => { (m.launch as Json).model = { value: "ok", source: "default", extra: true }; },
      (m: Json) => { (m.launch as Json).effort = { value: "High", source: "default" }; },
      (m: Json) => { (m.launch as Json).extra = true; },
    ]) {
      const p = fixture(version, "ok");
      change(p.m);
      rejects(p.manifest, seal(p.manifest, p.m), "AGENT_BINDING_MANIFEST");
    }
  });

  test(`v${version}: existing effort grammar accepts leading hyphen`, () => {
    const p = fixture(version, "ok");
    (p.m.launch as Json).effort = { value: "-bad", source: "default" };
    assert.deepEqual(readSealedManifest(p.manifest, seal(p.manifest, p.m)).m.launch?.effort,
      { value: "-bad", source: "default" });
  });

  test(`v${version}: unknown and cli-default metadata remain accepted`, () => {
    for (const source of ["unknown", "cli-default"]) {
      const p = fixture(version, "ok");
      (p.m.launch as Json).model = { value: "unknown", source };
      assert.deepEqual(readSealedManifest(p.manifest, seal(p.manifest, p.m)).m.launch?.model,
        { value: "unknown", source });
    }
  });

  test(`v${version}: hash, private root and final symlink controls`, () => {
    const p = fixture(version, "ok");
    rejects(p.manifest, "0".repeat(64), "SANDBOX_MANIFEST_CHANGED");
    chmodSync(p.root, 0o755);
    rejects(p.manifest, p.hash, "AGENT_BINDING_ROOT");
    chmodSync(p.root, 0o700);
    const other = fixture(version, "ok");
    unlinkSync(p.manifest);
    symlinkSync(other.manifest, p.manifest);
    rejects(p.manifest, p.hash, "AGENT_BINDING_FILE: manifest.json");
  });
}
