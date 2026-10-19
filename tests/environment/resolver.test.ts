import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyConfig, strictJson, validateConfig } from "../../src/environment/contract.js";
import { resolveSettings } from "../../src/environment/resolve.js";
import { awareness } from "../../src/environment/awareness.js";
import { environmentHome } from "../../src/environment/storage.js";
import { bootstrapEnvironment } from "../../src/environment/bootstrap.js";

test("strict schema rejects duplicate escaped keys, prototype, unknown, runtime and secret destinations", () => {
  for (const raw of ['{"revision":1,"revi\\u0073ion":2}', '{"__proto__":{}}', '{"constructor":1}', '{"x":{"prototype":1}}']) {
    assert.throws(() => strictJson(raw), /ENV_DUPLICATE_OR_PROTOTYPE_KEY/);
  }
  for (const id of ["unregistered", "AIGENTRY_WORKER_SCOPE", "AIGENTRY_CLAUDE_OAUTH_TOKEN", "task.sid"]) {
    assert.throws(() => validateConfig({ ...emptyConfig(), settings: { [id]: "fixture-value" } }), /ENV_UNKNOWN_SETTING/);
  }
  assert.throws(() => strictJson(" ".repeat(128 * 1024 + 1)), /TOO_LARGE/);
  assert.throws(() => strictJson("[".repeat(17) + "0" + "]".repeat(17)), /DEPTH/);
  assert.throws(() => validateConfig({ ...emptyConfig(), revision: -1 }), /SCHEMA/);
  assert.throws(() => validateConfig({ ...emptyConfig(), extra: true }), /SCHEMA/);
  assert.throws(() => validateConfig({ ...emptyConfig(), projects: { projectLabel: {} } }), /PROJECT_INVALID/);
});

test("flags, alias env, canonical project, selected profile, central baseline, owned legacy and caller defaults", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-resolution-")));
  try {
    const c = emptyConfig();
    c.settings = { "claude.model": "central-model" };
    c.profiles.work = { "claude.model": "profile-model" };
    c.selectedProfile = "work";
    c.projects[root] = { "claude.model": "project-model" };
    const input = { config: c, env: {}, targetCwd: root, role: "coder", legacy: { roles: { coder: { cli: "claude", model: "legacy-model" } }, foreign: { retained: true } } };
    const r = (env = {}, flags = {}) => resolveSettings({ ...input, env, flags });
    assert.equal(r({ AIGENTRY_CLAUDE_MODEL: "env-model" }, { "claude.model": "flag-model" }).provenance["claude.model"], "flag");
    assert.equal(r({ AIGENTRY_CLAUDE_MODEL: "env-model" }).values["claude.model"], "env-model");
    assert.equal(r().values["claude.model"], "project-model");
    c.projects = {}; assert.equal(r().provenance["claude.model"], "profile");
    c.selectedProfile = null; assert.equal(r().values["claude.model"], "central-model");
    c.settings = {}; assert.equal(r().values["claude.model"], "legacy-model");
    const defaults = resolveSettings({ config: emptyConfig(), env: {} });
    assert.equal(defaults.values["boot.sid"], "orchestrator");
    assert.equal(defaults.values["claude.model"], undefined); // each caller retains its shipped fallback
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("invalid high-priority values and same-layer aliases refuse; opaque legacy flags never defeat typed settings", () => {
  const c = emptyConfig(); c.settings["claude.model"] = "valid-model";
  assert.throws(() => resolveSettings({ config: c, env: { AIGENTRY_CLAUDE_MODEL: "" } }), /INVALID_VALUE/);
  assert.throws(() => resolveSettings({ config: c, env: { ORCHESTRATOR_CLI: "claude", AIGENTRY_BOOT_CLI: "codex" } }), /ALIAS_CONFLICT/);
  assert.doesNotThrow(() => resolveSettings({ config: c, env: { ORCHESTRATOR_CLI: "claude", AIGENTRY_BOOT_CLI: "claude" } }));
  assert.throws(() => resolveSettings({ config: c, env: {}, legacy: { defaults: { cli_flags: "--model opaque-model" } } }), /LEGACY_FLAGS_CONFLICT/);
  assert.doesNotThrow(() => resolveSettings({ config: emptyConfig(), env: {}, legacy: { defaults: { cli_flags: "--model opaque-model" } } }));
  assert.equal(resolveSettings({ config: emptyConfig(), env: { ORCHESTRATOR_SID: "orch[" } }).values["boot.sid"], "orch[");
});

test("metadata creates nothing, reads no native auth, and exposes no settings values or credential measures", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-metadata-")));
  const home = path.join(base, "missing-home");
  try {
    const b = bootstrapEnvironment({ AIGENTRY_HOME: home, AIGENTRY_CLAUDE_MODEL: "fixture-model-canary" });
    assert.equal(fs.existsSync(home), false);
    const serialized = JSON.stringify(awareness(b.resolution));
    assert.doesNotMatch(serialized, /fixture-model-canary|sha256|length|loggedIn|account/);
    assert.match(serialized, /authentication-unobserved/);
    assert.equal(environmentHome({ AIGENTRY_HOME: home }), home);
    assert.equal(bootstrapEnvironment({ AIGENTRY_HOME: home }).env.ORCHESTRATOR_SID, undefined, "caller fallback must not complete an incomplete explicit boot plan");
    for (const value of ["", "relative", "~/literal"]) assert.throws(() => environmentHome({ AIGENTRY_HOME: value }), /HOME_NOT_ABSOLUTE/);
  } finally { fs.rmSync(base, { recursive: true }); }
});
