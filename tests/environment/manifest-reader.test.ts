import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readSealedManifest } from "../../src/session/worker-sandbox.js";

test("historical v2 manifest survives grant absence but rejects extra and duplicate fields", { skip: process.platform === "win32" }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-manifest-")));
  const sid = "fixture", attempt = randomUUID(), grantId = randomUUID();
  const root = path.join(home, "sessions", sid, "sandbox", attempt);
  const file = path.join(root, "manifest.json");
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const m = { version: 2, task: "fixture", sid, attempt, cli: "claude", cwd: "/tmp/project",
      command: ["/tmp/claude"], env: {},
      config: { network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [],
        allowAllUnixSockets: false, allowLocalBinding: false },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      allowPty: true, allowAppleEvents: false, enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false },
      probeFile: path.join(root, "outside-canary.txt"),
      probeDirectory: path.join(root, "outside-directory-canary"), receipt: path.join(root, "receipt.json"),
      controllerRootId: randomUUID(), authorityGeneration: 1,
      targetProject: { enrollmentId: randomUUID(), canonicalRoot: "/tmp/project", identity: { dev: "1", ino: "2" }, epoch: 1 },
      delivery: { grantId, grantArtifact: path.join(home, "environment", "grants", grantId, "grant.json") },
      launchPolicy: { kind: "managed-secret", restart: "never" },
      executable: { cli: "claude", path: "/tmp/claude", realpath: "/tmp/claude", dev: 1, ino: 2,
        size: 1, mtimeMs: 1, version: null, versionSource: "unknown" } };
    const check = (raw: string) => {
      fs.writeFileSync(file, raw, { mode: 0o600 });
      return readSealedManifest(file, createHash("sha256").update(raw).digest("hex"));
    };
    assert.equal(check(JSON.stringify(m)).m.attempt, attempt);
    assert.throws(() => check(JSON.stringify({ ...m, unknown: true })), /AGENT_BINDING_MANIFEST/);
    assert.throws(() => check(JSON.stringify(m).replace('"version":2', '"version":2,"version":2')), /AGENT_BINDING_MANIFEST/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
