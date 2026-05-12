// ADR §4.8.2 — index lock tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withIndexLock } from "../../../src/session/persistence/index-lock.js";

async function mkTmpDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mf14-il-${label}-`));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("basic acquire/release: lock file gone after fn returns", async () => {
  const dir = await mkTmpDir("basic");
  const target = path.join(dir, "index.json");
  const result = await withIndexLock(target, async () => {
    await fs.access(`${target}.lock`); // exists during fn
    return 42;
  });
  assert.equal(result, 42);
  await assert.rejects(fs.access(`${target}.lock`)); // gone after
});

test("serialization: second acquire waits until first releases", async () => {
  const dir = await mkTmpDir("serialize");
  const target = path.join(dir, "index.json");
  const order: string[] = [];

  const first = withIndexLock(target, async () => {
    order.push("first-enter");
    await sleep(150);
    order.push("first-exit");
  });

  // Stagger so second is guaranteed to attempt acquisition after first holds it.
  await sleep(20);

  const second = withIndexLock(target, async () => {
    order.push("second-enter");
    order.push("second-exit");
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first-enter",
    "first-exit",
    "second-enter",
    "second-exit",
  ]);
});

test("timeout: acquire fails when lock never released", async () => {
  const dir = await mkTmpDir("timeout");
  const target = path.join(dir, "index.json");
  // Hold the lock from a parallel call that we never resolve until after the timeout fires.
  let release!: () => void;
  const holdGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withIndexLock(target, async () => {
    await holdGate;
  });
  await sleep(20);
  await assert.rejects(
    withIndexLock(target, async () => {}, { timeoutMs: 100 }),
    /timeout/,
  );
  release();
  await holder;
});

test("stale lock from dead PID is reclaimed", async () => {
  const dir = await mkTmpDir("stale");
  const target = path.join(dir, "index.json");
  // Forge a lock file claiming to be held by an impossibly high PID.
  // 2^22 + 7 is well above /proc/sys/kernel/pid_max defaults; kill(0) returns ESRCH.
  await fs.writeFile(`${target}.lock`, `${(1 << 22) + 7}\n`);
  const result = await withIndexLock(
    target,
    async () => "reclaimed",
    { timeoutMs: 1_000 },
  );
  assert.equal(result, "reclaimed");
});

test("malformed lock file (non-numeric PID) treated as stale", async () => {
  const dir = await mkTmpDir("malformed");
  const target = path.join(dir, "index.json");
  await fs.writeFile(`${target}.lock`, "garbage\n");
  const result = await withIndexLock(
    target,
    async () => "ok",
    { timeoutMs: 1_000 },
  );
  assert.equal(result, "ok");
});
