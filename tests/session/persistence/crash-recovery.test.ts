// ADR §4.8.2 — crash recovery tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sweepIncompleteWrites } from "../../../src/session/persistence/crash-recovery.js";

async function mkTmpDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mf14-cr-${label}-`));
}

test("non-existent root: empty report, no error", async () => {
  const dir = await mkTmpDir("missing");
  await fs.rm(dir, { recursive: true });
  const report = await sweepIncompleteWrites(dir);
  assert.equal(report.scanned, 0);
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.errors, []);
});

test("deletes *.tmp.* files; preserves regular snapshots", async () => {
  const dir = await mkTmpDir("basic");
  const sess = path.join(dir, "sess-abc");
  await fs.mkdir(sess, { recursive: true });
  await fs.writeFile(path.join(sess, "context.json"), "{}");
  await fs.writeFile(path.join(sess, "context.json.tmp.sess-abc.99999"), "{}");
  await fs.writeFile(path.join(sess, "lineage.json.tmp.sess-abc.42"), "{}");
  const report = await sweepIncompleteWrites(dir);
  assert.equal(report.deleted.length, 2);
  assert.equal(report.errors.length, 0);
  const remaining = await fs.readdir(sess);
  assert.deepEqual(remaining, ["context.json"]);
});

test("recurses into nested session directories", async () => {
  const dir = await mkTmpDir("nested");
  const a = path.join(dir, "sess-a", "agents");
  const b = path.join(dir, "sess-b");
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(a, "agent-1.json.tmp.sess-a.1"), "x");
  await fs.writeFile(path.join(b, "context.json.tmp.sess-b.2"), "x");
  await fs.writeFile(path.join(b, "context.json"), "{}");
  const report = await sweepIncompleteWrites(dir);
  assert.equal(report.deleted.length, 2);
  assert.deepEqual(
    report.deleted.map((p) => path.basename(p)).sort(),
    ["agent-1.json.tmp.sess-a.1", "context.json.tmp.sess-b.2"],
  );
});

test("file without .tmp. infix is preserved even if name contains 'tmp'", async () => {
  const dir = await mkTmpDir("namelike");
  await fs.writeFile(path.join(dir, "tmp-snapshot.json"), "x");
  await fs.writeFile(path.join(dir, "snapshot.tmp"), "x"); // no trailing dot+suffix
  const report = await sweepIncompleteWrites(dir);
  assert.deepEqual(report.deleted, []);
  assert.equal((await fs.readdir(dir)).length, 2);
});

test("scanned counter reflects every file inspected", async () => {
  const dir = await mkTmpDir("count");
  await fs.writeFile(path.join(dir, "a.json"), "x");
  await fs.writeFile(path.join(dir, "b.json"), "x");
  await fs.writeFile(path.join(dir, "c.json.tmp.s.1"), "x");
  const report = await sweepIncompleteWrites(dir);
  assert.equal(report.scanned, 3);
  assert.equal(report.deleted.length, 1);
});
