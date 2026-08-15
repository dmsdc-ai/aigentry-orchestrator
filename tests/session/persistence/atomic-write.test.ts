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

// #901 — run a block with process.platform reporting something else.
//
// The win32 arm is read at call time, so this makes it reachable from ubuntu and macos:
// the Windows code path is then covered by EVERY CI leg instead of only the Windows one.
// That is deliberately NOT the whole proof. This says "the win32 branch is taken and its
// logic is right"; it cannot say anything about NTFS rename semantics, a real AV scanner
// holding a handle, or whether a directory can be opened for fsync. Those are proven by
// the W1 leg in ci.yml, which runs this same suite natively on windows-latest. Neither
// proof substitutes for the other, and dropping either one would leave the arm asserted
// only by inference.
async function asPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const real = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: real,
      configurable: true,
    });
  }
}

test("win32 arm: writes the exact bytes and leaves no tmp behind", async () => {
  const dir = await mkTmpDir("win-basic");
  const target = path.join(dir, "snapshot.json");
  const payload = new TextEncoder().encode('{"win":true}\n');
  await asPlatform("win32", () =>
    atomicWrite(target, payload, { sessionId: "sess-w" }),
  );
  assert.deepEqual(new Uint8Array(await fs.readFile(target)), payload);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["snapshot.json"]);
});

test("win32 arm: overwrite replaces the target", async () => {
  const dir = await mkTmpDir("win-overwrite");
  const target = path.join(dir, "snapshot.json");
  await asPlatform("win32", async () => {
    await atomicWrite(target, new TextEncoder().encode("w1"), {
      sessionId: "sess-a",
    });
    await atomicWrite(target, new TextEncoder().encode("w2"), {
      sessionId: "sess-b",
    });
  });
  assert.equal(await fs.readFile(target, "utf8"), "w2");
});

test("win32 arm: sessionId validation still applies", async () => {
  const dir = await mkTmpDir("win-sid");
  const target = path.join(dir, "snapshot.json");
  await assert.rejects(
    asPlatform("win32", () =>
      atomicWrite(target, new Uint8Array([1]), { sessionId: "bad/sid" }),
    ),
    /invalid sessionId/,
  );
});

test("win32 arm: an unrecoverable rename gives up bounded, and leaves no tmp", async () => {
  // A directory sitting on the target path can never be replaced by a file rename, so
  // every retry fails the same way. This is the case that separates "bounded retry" from
  // "retry loop": the call must reject with the underlying error rather than spin, and it
  // must still clean the tmp up on the way out.
  const dir = await mkTmpDir("win-giveup");
  const target = path.join(dir, "snapshot.json");
  await fs.mkdir(target);
  const started = Date.now();
  await assert.rejects(
    asPlatform("win32", () =>
      atomicWrite(target, new Uint8Array([1]), { sessionId: "sess" }),
    ),
    (err: Error) => {
      assert.doesNotMatch(err.message, /deferred/);
      return true;
    },
  );
  assert.ok(
    Date.now() - started < 20_000,
    "retry budget must be bounded well inside the test timeout",
  );
  const leftover = (await fs.readdir(dir)).filter((n) =>
    n.startsWith("snapshot.json.tmp."),
  );
  assert.deepEqual(leftover, []);
});

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
