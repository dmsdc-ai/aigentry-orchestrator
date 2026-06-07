// ADR-MF #13 — per-adapter argv / env / cwd shape contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
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

test("4. codex argv = real default flags; additive descriptor (AGENTS.md / CODEX_HOME) (#532)", async () => {
  // #532 reconcile (2026-06-07): the prior `--cd` argv + CODEX_NO_CONTEXT_AUTOLOAD /
  // CODEX_SYSTEM_PROMPT_FILE env did NOT exist in codex 0.133.0. The additive design
  // delivers the role prompt via a cwd `AGENTS.md` (staged by boot-prepare in the
  // sandbox cwd) and neutralizes the global doc via a CODEX_HOME shadow home. The
  // adapter only declares the REAL launch flags + the additive descriptor; the boot
  // process cwd = ctx.cwd (sandbox), not a scratch /control dir.
  const fs = memoryBootFs();
  const adapter = getBootAdapter("codex");
  const cmd = await adapter.buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs, spawner: mockSpawner(ALL()),
  });
  assert.deepEqual([...cmd.argv], [
    "codex", "-c", "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.equal(cmd.cwd, "/work/myproj");
  assert.equal(cmd.code_scope_cwd, "/work/myproj");
  assert.deepEqual({ ...cmd.env }, {});
  assert.equal(adapter.contextFile, "AGENTS.md");
  assert.equal(adapter.homeEnv, "CODEX_HOME");
  assert.deepEqual([...adapter.homeExclude], ["AGENTS.md", "AGENTS.override.md"]);
});

test("5. gemini argv = real default flags; additive descriptor (GEMINI.md / GEMINI_CLI_HOME) (#532)", async () => {
  // #532 reconcile: gemini 0.42.0 has NO `--system` / `--workspace-root` flags and
  // no GEMINI_NO_CONTEXT_AUTOLOAD env. Real flags are -m/--approval-mode/--skip-trust;
  // the role prompt is delivered via cwd `GEMINI.md`, global doc neutralized via the
  // GEMINI_CLI_HOME shadow home.
  const adapter = getBootAdapter("gemini");
  const cmd = await adapter.buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: memoryBootFs(), spawner: mockSpawner(ALL()),
  });
  assert.deepEqual([...cmd.argv], [
    "gemini", "-m", "gemini-2.5-flash",
    "--approval-mode", "yolo", "--skip-trust",
  ]);
  assert.equal(cmd.cwd, "/work/myproj");
  assert.equal(cmd.code_scope_cwd, "/work/myproj");
  assert.deepEqual({ ...cmd.env }, {});
  assert.equal(adapter.contextFile, "GEMINI.md");
  assert.equal(adapter.homeEnv, "GEMINI_CLI_HOME");
  assert.deepEqual([...adapter.homeExclude], ["GEMINI.md"]);
});

test("5b. gemini argv reads AIGENTRY_GEMINI_MODEL override (#551)", async () => {
  const prior = process.env.AIGENTRY_GEMINI_MODEL;
  process.env.AIGENTRY_GEMINI_MODEL = "gemini-test-override";
  try {
    const cmd = await getBootAdapter("gemini").buildBootCommand(makeCtx(), makeResolved(), {
      staging_dir: STAGING, fs: memoryBootFs(), spawner: mockSpawner(ALL()),
    });
    assert.deepEqual([...cmd.argv], [
      "gemini", "-m", "gemini-test-override",
      "--approval-mode", "yolo", "--skip-trust",
    ]);
  } finally {
    if (prior === undefined) delete process.env.AIGENTRY_GEMINI_MODEL;
    else process.env.AIGENTRY_GEMINI_MODEL = prior;
  }
});

test("6. codex additive path does NOT probe --cd (no scratch /control dir) (#532)", async () => {
  // #532: the additive path keeps cwd=sandbox and never passes codex `-C/--cd`, so a
  // spawner reporting zero features must still build (the obsolete codeCwdFlag probe
  // that previously rejected codex-without-`--cd` no longer applies).
  const sp = mockSpawner({
    codex: { version: "1.0.0", features: [], on_run: () => ({ stdout: "", stderr: "", exit_code: 0, duration_ms: 1 }) },
  });
  const cmd = await getBootAdapter("codex").buildBootCommand(makeCtx(), makeResolved(), {
    staging_dir: STAGING, fs: memoryBootFs(), spawner: sp,
  });
  assert.equal(cmd.argv[0], "codex");
  assert.equal(cmd.cwd, "/work/myproj");
});

test("6b. claude exposes a null additive descriptor (flag-based role delivery) (#532)", async () => {
  const a = getBootAdapter("claude");
  assert.equal(a.contextFile, null);
  assert.equal(a.homeEnv, null);
  assert.deepEqual([...a.homeExclude], []);
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
