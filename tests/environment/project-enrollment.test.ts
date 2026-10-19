import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { controllerContext, disableProject, enrollProject, upgradeConfig } from "../../src/environment/grants.js";
import { readConfig } from "../../src/environment/storage.js";

test("canonical enrollment is revisioned, unique, and tombstoned", { skip: process.platform === "win32" }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-enroll-")));
  const home = path.join(base, "home"), project = path.join(base, "project");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  try {
    upgradeConfig(home, 0);
    const ctx = controllerContext(home);
    const added = enrollProject(ctx, project, 1);
    assert.equal(added.revision, 2);
    assert.throws(() => enrollProject(ctx, project, 2), /ENV_PROJECT_ENROLLED/);
    assert.equal(disableProject(ctx, added.id, 2), 3);
    const config = readConfig(home);
    assert.equal(config.version, 2);
    if (config.version === 2) {
      assert.equal(config.projectEnrollments[added.id]?.enabled, false);
      assert.equal(config.projectEnrollments[added.id]?.securityEpoch, 2);
    }
    assert.throws(() => disableProject(ctx, added.id, 2), /ENV_REVISION_CONFLICT/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
