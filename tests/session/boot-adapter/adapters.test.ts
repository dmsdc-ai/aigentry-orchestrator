// ADR-MF #13 — per-adapter argv / env / cwd shape contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  BootAdapterError,
  getBootAdapter,
  memoryBootFs,
  mockSpawner,
} from "../../../src/session/boot-adapter/index.js";
import { sha256Hex } from "../../../src/session/persistence/canonical-bytes.js";
import {
  EFFECTIVE_PROMPT, EXPECTED_DIGEST, makeCtx, makeResolved, readyScript,
} from "./_fixtures.js";

const STAGING = "/tmp/sess-A";
const ALL = () => ({ claude: readyScript(), codex: readyScript(), gemini: readyScript() });

test("3. claude argv = --append-system-prompt-file <staged> (#431 hybrid pivot from --bare)", async () => {
  // 2026-05-23 (#431): argv changed from `--bare --system-prompt-file` to
  // `--append-system-prompt-file` because `--bare` disables OAuth/keychain auth
  // and the deployed user runs on OAuth (verified empirically: `claude --bare`
  // → "Not logged in"). The cwd→role contamination is closed instead by the
  // hybrid (b-2)+(c): system-prompt-level role override + sandbox cwd
  // (the latter chosen by bin/boot-prepare.mjs, not this adapter).
  const cmd = await getBootAdapter("claude").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: memoryBootFs(), spawner: mockSpawner(ALL()),
  });
  assert.deepEqual([...cmd.argv], [
    "claude", "--append-system-prompt-file",
    path.join(STAGING, "effective_prompt.md"),
  ]);
  assert.equal(cmd.cwd, "/work/myproj");
  assert.equal(cmd.code_scope_cwd, "/work/myproj");
  assert.deepEqual({ ...cmd.env }, {});
});

test("4. codex argv + scratch cwd + env vars (suppression belt-and-suspenders)", async () => {
  const fs = memoryBootFs();
  const cmd = await getBootAdapter("codex").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs, spawner: mockSpawner(ALL()),
  });
  assert.deepEqual([...cmd.argv], ["codex", "--cd", "/work/myproj"]);
  assert.equal(cmd.cwd, path.join(STAGING, "control"));
  assert.equal(cmd.code_scope_cwd, "/work/myproj");
  assert.equal(cmd.env["CODEX_NO_CONTEXT_AUTOLOAD"], "1");
  assert.equal(cmd.env["CODEX_SYSTEM_PROMPT_FILE"], cmd.prompt_file);
  assert.ok(await fs.exists(cmd.cwd), "scratch cwd materialized");
});

test("5. gemini argv + --workspace-root + env suppression", async () => {
  const cmd = await getBootAdapter("gemini").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: memoryBootFs(), spawner: mockSpawner(ALL()),
  });
  assert.deepEqual([...cmd.argv], [
    "gemini", "--system", path.join(STAGING, "effective_prompt.md"),
    "--workspace-root", "/work/myproj",
  ]);
  assert.equal(cmd.cwd, path.join(STAGING, "control"));
  assert.equal(cmd.env["GEMINI_NO_CONTEXT_AUTOLOAD"], "1");
});

test("6. ERR_BOOT_ADAPTER_UNSUPPORTED when codex lacks --cd flag (§4.5.1.1)", async () => {
  const sp = mockSpawner({
    codex: { version: "1.0.0", features: [], on_run: () => new Error("unreached") },
  });
  await assert.rejects(
    getBootAdapter("codex").buildBootCommand(makeCtx(), makeResolved(), {
      staging_dir: STAGING, fs: memoryBootFs(), spawner: sp,
    }),
    (e: unknown) => e instanceof BootAdapterError
      && (e as BootAdapterError).code === "ERR_BOOT_ADAPTER_UNSUPPORTED",
  );
});

test("13. prompt bytes byte-equal resolved.effective_prompt (no in-flight mutation)", async () => {
  const fs = memoryBootFs();
  const cmd = await getBootAdapter("claude").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs, spawner: mockSpawner(ALL()),
  });
  const bytes = await fs.readFile(cmd.prompt_file);
  assert.equal(sha256Hex(bytes), EXPECTED_DIGEST);
  assert.equal(new TextDecoder().decode(bytes), EFFECTIVE_PROMPT);
  assert.equal(cmd.expected_digest, EXPECTED_DIGEST);
});

test("15. determinism: two builds produce structurally-equal BootCommand", async () => {
  const sp = mockSpawner(ALL());
  const fs1 = memoryBootFs();
  const fs2 = memoryBootFs();
  const a = await getBootAdapter("codex").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: fs1, spawner: sp,
  });
  const b = await getBootAdapter("codex").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: fs2, spawner: sp,
  });
  assert.deepEqual([...a.argv], [...b.argv]);
  assert.deepEqual({ ...a.env }, { ...b.env });
  assert.equal(a.cwd, b.cwd);
  assert.equal(a.expected_digest, b.expected_digest);
  assert.deepEqual(await fs1.readFile(a.prompt_file), await fs2.readFile(b.prompt_file));
});

test("16. BC sanity: existing #99/#101/#103/#114 modules import + work unchanged", async () => {
  const t = await import("../../../src/session/types.js");
  const r = await import("../../../src/session/resolve-instructions.js");
  const p = await import("../../../src/session/permission-manager.js");
  const cb = await import("../../../src/session/persistence/canonical-bytes.js");
  assert.equal(cb.sha256Hex(cb.canonicalBytes(EFFECTIVE_PROMPT)), EXPECTED_DIGEST);
  assert.ok(t.Role.coder === "coder");
  assert.equal(typeof r.resolveInstructions, "function");
  assert.equal(typeof p.checkSpawnPermissions, "function");
});
