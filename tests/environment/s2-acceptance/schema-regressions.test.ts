import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { finish, fixture, invokeNode, publicEntry } from "./fixture.js";

test("public env metadata commands preserve cold-state visibility without secret values", { skip: process.platform === "win32" }, () => {
  const root = fixture(), evidence: Array<{ command: string; status: number | null }> = [];
  for (const args of [["list", "--json"], ["explain", "claude.worker.oauth"], ["doctor", "--json"]]) {
    const result = invokeNode(publicEntry(), ["env", ...args], root,
      { AIGENTRY_CLAUDE_OAUTH_TOKEN: "source-canary", AWS_SECRET_ACCESS_KEY: "vault-canary" });
    assert.equal(result.status, 0, result.stderr);
    const value: unknown = JSON.parse(result.stdout);
    assert.ok(value && typeof value === "object");
    assert.equal((result.stdout + result.stderr).includes("source-canary"), false);
    assert.equal((result.stdout + result.stderr).includes("vault-canary"), false);
    evidence.push({ command: args.join(" "), status: result.status });
  }
  finish(root, evidence);
});

test("public schema upgrade and project enrollment require current revision and canonical root", { skip: process.platform === "win32" }, () => {
  const root = fixture(), project = path.join(root, "project");
  fs.mkdirSync(path.join(root, "central"), { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  const run = (args: string[]) => invokeNode(publicEntry(), ["env", ...args], root);
  const upgraded = run(["schema", "upgrade", "--expected-revision", "0"]);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const revision = (JSON.parse(upgraded.stdout) as { revision: number }).revision;
  const enrolled = run(["project", "enroll", project, "--expected-revision", String(revision)]);
  assert.equal(enrolled.status, 0, enrolled.stderr);
  const data = JSON.parse(enrolled.stdout) as { enrollmentId: string; revision: number };
  assert.match(data.enrollmentId, /^[0-9a-f-]{36}$/);
  const stale = run(["project", "enroll", project, "--expected-revision", String(revision)]);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /ENV_REVISION_CONFLICT/);
  const renamed = path.join(root, "renamed");
  fs.renameSync(project, renamed);
  const oldRoot = run(["project", "enroll", project, "--expected-revision", String(data.revision)]);
  assert.notEqual(oldRoot.status, 0);
  finish(root, { upgradeRevision: revision, enrollmentRevision: data.revision,
    stale: stale.stderr.trim(), renamed: oldRoot.stderr.trim() });
});
