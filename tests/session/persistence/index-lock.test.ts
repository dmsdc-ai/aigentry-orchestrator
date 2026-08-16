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

// #905 — wait until the holder ACTUALLY holds the lock.
//
// Every staggered test below used `await sleep(20)` for this, and a fixed sleep is not a
// synchronisation primitive. acquire() writes a staging file, fsyncs it, and only then
// links it into place; on a loaded runner that can take longer than any constant chosen
// here, and when it does the second acquirer gets the lock FIRST and the test asserts the
// opposite of what happened. Observed on windows-latest under full-suite load: "timeout:
// acquire fails when lock never released" failed in the full run while passing in the
// persistence-only run of the very same job — the ratchet in ci.yml caught it as a
// 33→34 move. Polling the real post-condition removes the race instead of widening it.
async function awaitHeld(target: string): Promise<void> {
  const lockPath = `${target}.lock`;
  for (let i = 0; i < 600; i++) {
    try {
      await fs.access(lockPath);
      return;
    } catch {
      await sleep(5);
    }
  }
  throw new Error(`lock ${lockPath} was never taken — the holder failed to acquire`);
}

// #901 — see the same helper in atomic-write.test.ts for why this exists and what it does
// NOT prove. Short version: it makes the win32 arm reachable from every CI leg; the W1
// leg in ci.yml proves the platform itself behaves as the arm assumes (hard links on
// NTFS, kill(pid, 0) reporting ESRCH for a pid that cannot exist).
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

test("win32 arm: basic acquire/release, lock file gone after fn returns", async () => {
  const dir = await mkTmpDir("win-basic");
  const target = path.join(dir, "index.json");
  const result = await asPlatform("win32", () =>
    withIndexLock(target, async () => {
      await fs.access(`${target}.lock`);
      return 42;
    }),
  );
  assert.equal(result, 42);
  await assert.rejects(fs.access(`${target}.lock`));
});

test("win32 arm: serialization — second acquire waits for the first", async () => {
  const dir = await mkTmpDir("win-serialize");
  const target = path.join(dir, "index.json");
  const order: string[] = [];
  await asPlatform("win32", async () => {
    const first = withIndexLock(target, async () => {
      order.push("first-enter");
      await sleep(150);
      order.push("first-exit");
    });
    await awaitHeld(target);
    const second = withIndexLock(target, async () => {
      order.push("second-enter");
    });
    await Promise.all([first, second]);
  });
  assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
});

test("win32 arm: dead-pid lock is reclaimed (held/dead/vanished contract, #897)", async () => {
  const dir = await mkTmpDir("win-stale");
  const target = path.join(dir, "index.json");
  // Not a multiple of 4, so it cannot be a Windows pid either — kill(pid, 0) must report
  // ESRCH on both platforms for this to be classified "dead" rather than "held".
  await fs.writeFile(`${target}.lock`, `${(1 << 22) + 7}\n`);
  const result = await asPlatform("win32", () =>
    withIndexLock(target, async () => "reclaimed", { timeoutMs: 2_000 }),
  );
  assert.equal(result, "reclaimed");
});

test("win32 arm: timeout still fires when the lock is never released", async () => {
  const dir = await mkTmpDir("win-timeout");
  const target = path.join(dir, "index.json");
  await asPlatform("win32", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = withIndexLock(target, () => gate);
    await awaitHeld(target);
    await assert.rejects(
      withIndexLock(target, async () => {}, { timeoutMs: 100 }),
      /timeout/,
    );
    release();
    await holder;
  });
});

test("the lock is released even when fn throws", async () => {
  const dir = await mkTmpDir("throwing-fn");
  const target = path.join(dir, "index.json");
  await assert.rejects(
    withIndexLock(target, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // A leaked lock here is worse on Windows than on POSIX: the pid in it is ours and
  // still alive, so every later waiter reads "held" and blocks until its own timeout.
  await assert.rejects(fs.access(`${target}.lock`));
});

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
  await awaitHeld(target);

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
  await awaitHeld(target);
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
