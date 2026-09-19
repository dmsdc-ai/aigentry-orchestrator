import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Resolve at runtime so compiling this harness never recompiles production code.
const helperUrl = new URL("../../../src/session/persistence/index-lock.js", import.meta.url);
const { withIndexLock } = await import(helperUrl.href) as {
  withIndexLock<T>(target: string, callback: () => Promise<T>, options?: {
    strictRelease?: boolean;
  }): Promise<T>;
};

for (const scenario of [
  { name: "omitted strictRelease preserves best-effort release", strict: undefined, releaseFails: true, callbackFails: false },
  { name: "explicit false preserves best-effort release", strict: false, releaseFails: true, callbackFails: false },
  { name: "strict successful release returns callback value", strict: true, releaseFails: false, callbackFails: false },
  { name: "strict release EIO rejects after callback success", strict: true, releaseFails: true, callbackFails: false },
  { name: "callback error remains primary when strict release also fails", strict: true, releaseFails: true, callbackFails: true },
]) {
  test(scenario.name, { concurrency: false }, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "index-lock-strict-"));
    const target = join(root, "index.json");
    const lockPath = `${target}.lock`;
    const originalUnlink = fs.unlink;
    const releaseError = Object.assign(new Error("injected release failure"), { code: "EIO" });
    const callbackError = new Error("injected callback failure");
    const value = { saved: true };
    let releaseAttempts = 0;
    let callbackCalls = 0;
    try {
      fs.unlink = async (path) => {
        if (path === lockPath) {
          releaseAttempts++;
          if (scenario.releaseFails) throw releaseError;
        }
        await originalUnlink(path);
      };
      syncBuiltinESMExports();
      const result = withIndexLock(target, async () => {
        callbackCalls++;
        assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);
        if (scenario.callbackFails) throw callbackError;
        return value;
      }, scenario.strict === undefined ? undefined : { strictRelease: scenario.strict });
      if (scenario.callbackFails) {
        await assert.rejects(result, (error: unknown) => error === callbackError);
      } else if (scenario.strict && scenario.releaseFails) {
        await assert.rejects(result, (error: unknown) => error === releaseError);
      } else {
        assert.equal(await result, value);
      }
      assert.equal(callbackCalls, 1);
      assert.equal(releaseAttempts, 1);
      if (scenario.releaseFails) {
        assert.equal(await fs.readFile(lockPath, "utf8"), `${process.pid}\n`);
      } else {
        await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
      }
    } finally {
      fs.unlink = originalUnlink;
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
