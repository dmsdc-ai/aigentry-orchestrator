// ADR §4.8.2 — atomic write tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite } from "../../../src/session/persistence/atomic-write.js";

async function mkTmpDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mf14-aw-${label}-`));
}

test("basic write: target contains exact bytes, no tmp left behind", async () => {
  const dir = await mkTmpDir("basic");
  const target = path.join(dir, "snapshot.json");
  const payload = new TextEncoder().encode('{"k":"v"}\n');
  await atomicWrite(target, payload, { sessionId: "sess-1" });
  const read = await fs.readFile(target);
  assert.deepEqual(new Uint8Array(read), payload);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.sort(), ["snapshot.json"]);
});

test("overwrite: subsequent atomic writes replace the target atomically", async () => {
  const dir = await mkTmpDir("overwrite");
  const target = path.join(dir, "snapshot.json");
  await atomicWrite(target, new TextEncoder().encode("v1"), {
    sessionId: "sess-a",
  });
  await atomicWrite(target, new TextEncoder().encode("v2"), {
    sessionId: "sess-b",
  });
  assert.equal(await fs.readFile(target, "utf8"), "v2");
});

test("100 concurrent writes: exactly one body survives, no .tmp leaks", async () => {
  const dir = await mkTmpDir("concurrent");
  const target = path.join(dir, "snapshot.json");
  const N = 100;
  const writers = Array.from({ length: N }, (_, i) =>
    atomicWrite(target, new TextEncoder().encode(`writer-${i}`), {
      sessionId: `sess-${i}`,
    }),
  );
  await Promise.all(writers);
  const final = await fs.readFile(target, "utf8");
  assert.match(final, /^writer-\d+$/);
  const leftover = (await fs.readdir(dir)).filter((n) =>
    n.startsWith("snapshot.json.tmp."),
  );
  assert.deepEqual(leftover, []);
});

test("invalid sessionId rejected (path separator)", async () => {
  const dir = await mkTmpDir("invalid");
  const target = path.join(dir, "snapshot.json");
  await assert.rejects(
    atomicWrite(target, new Uint8Array([1]), { sessionId: "bad/sid" }),
    /invalid sessionId/,
  );
});

test("empty sessionId rejected", async () => {
  const dir = await mkTmpDir("empty-sid");
  const target = path.join(dir, "snapshot.json");
  await assert.rejects(
    atomicWrite(target, new Uint8Array([1]), { sessionId: "" }),
    /invalid sessionId/,
  );
});

test("write into non-existent directory fails and leaves no tmp", async () => {
  const dir = await mkTmpDir("missing-dir");
  const target = path.join(dir, "no-such-subdir", "snapshot.json");
  await assert.rejects(
    atomicWrite(target, new Uint8Array([1]), { sessionId: "sess" }),
  );
  // Parent dir of target doesn't exist, so no tmp could have been created there.
  assert.equal((await fs.readdir(dir)).length, 0);
});
