// #1171 WU-1 (Snyk #24/#25) — assertConfinedTarget refuses a sid outside the module's
// `identity` shape before ANY filesystem call, so a traversal sid can never steer the
// sandbox-current.json -> manifest -> receipt chain (or stageWorkerRef's ref write) to a
// planted location. Each refused case plants a chain that is otherwise valid (same bytes the
// accepted control in (c) passes with), so the refusal is attributable to the sid alone.
//   (a) traversal sid + planted chain -> SANDBOX_TARGET_SID, zero fs calls (zero reads)
//   (b) stageWorkerRef with the same sid -> refused, no .telepty/shared/*.md written
//   (c) a valid sid still reaches the existing checks (ENOENT / NOT_RUNNING / accepted)
// POSIX and win32 separator forms run on every OS: the regex refuses `/` and `\` alike, and
// each chain is planted at path.join(sessions, sid), i.e. where this OS would resolve it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConfinedTarget, stageWorkerRef } from "../../src/session/worker-sandbox.js";

const require = createRequire(import.meta.url);
const TASK = "1171";
const TRAVERSAL = ["../evil", "..\\evil", "..", "x/../../evil", "x\\..\\..\\evil"];
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// worker-sandbox.ts imports node:fs as a namespace; replacing a function on the builtin module
// object and calling syncBuiltinESMExports() makes the namespace see it. Every *Sync function
// is recorded (name + first argument) and restored in `finally`.
const fsModule = require("node:fs") as Record<string, unknown>;
function recordFs<T>(fn: () => T): { calls: string[]; result?: T; error?: Error } {
  const calls: string[] = [];
  const saved = new Map<string, unknown>();
  try {
    for (const [name, orig] of Object.entries(fsModule)) {
      if (!name.endsWith("Sync") || typeof orig !== "function") continue;
      saved.set(name, orig);
      fsModule[name] = function (this: unknown, ...a: unknown[]) {
        calls.push(`${name} ${String(a[0])}`);
        return (orig as (...x: unknown[]) => unknown).apply(this, a);
      };
    }
    syncBuiltinESMExports();
    try { return { calls, result: fn() }; } catch (e) { return { calls, error: e as Error }; }
  } finally {
    for (const [name, orig] of saved) fsModule[name] = orig;
    syncBuiltinESMExports();
  }
}

/** A self-consistent running chain at path.join(sessions, sid); PIDs are this test process. */
function plant(sessions: string, sid: string, task = TASK): { staging: string; home: string } {
  const staging = join(sessions, sid), home = join(staging, "planted-home");
  mkdirSync(home, { recursive: true });
  const receipt = join(staging, "receipt.json"), manifest = join(staging, "manifest.json");
  const raw = JSON.stringify({ version: 1, sid, task, attempt: "planted-attempt", env: { HOME: home }, receipt });
  const hash = sha256(raw);
  writeFileSync(manifest, raw);
  writeFileSync(join(staging, "sandbox-current.json"), JSON.stringify({ manifest, hash }));
  writeFileSync(receipt, JSON.stringify({ hash, attempt: "planted-attempt", state: "running",
    supervisorPid: process.pid, childPid: process.pid }));
  return { staging, home };
}

function withRoot(fn: (root: string, sessions: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "target-sid-1171-")));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  try { fn(root, sessions); } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const sid of TRAVERSAL) {
  test(`(a) assertConfinedTarget refuses ${JSON.stringify(sid)} with a planted chain and makes zero fs calls`, () => {
    withRoot((_root, sessions) => {
      plant(sessions, sid);
      const r = recordFs(() => assertConfinedTarget(join(sessions, sid), sid, TASK));
      assert.equal(r.error?.message, "SANDBOX_TARGET_SID");
      assert.deepEqual(r.calls, [], "the refusal must precede every filesystem call");
    });
  });

  test(`(b) stageWorkerRef refuses ${JSON.stringify(sid)} and writes no shared ref`, () => {
    withRoot((root, sessions) => {
      const { home } = plant(sessions, sid);
      const ref = join(root, "ref.md");
      writeFileSync(ref, "planted-chain ref body\n");
      const r = recordFs(() => stageWorkerRef(join(sessions, sid), sid, TASK, ref));
      assert.equal(r.error?.message, "SANDBOX_TARGET_SID");
      assert.deepEqual(r.calls, [], "neither the chain nor the ref file may be touched");
      assert.equal(existsSync(join(home, ".telepty")), false, "no .telepty/shared/*.md under the planted HOME");
    });
  });
}

test("(c) a valid sid still reaches the existing checks: ENOENT, NOT_RUNNING, and an accepted chain", () => {
  withRoot((root, sessions) => {
    const sid = "sh1171aks-coder";
    // No chain: the first fs call is the existing sandbox-current.json read, and its error surfaces unchanged.
    const missing = recordFs(() => assertConfinedTarget(join(sessions, sid), sid, TASK));
    assert.equal((missing.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal(missing.calls[0], `readFileSync ${join(sessions, sid, "sandbox-current.json")}`);
    // The same planted chain the refused cases use: wrong task -> the existing binding check refuses.
    const { home } = plant(sessions, sid);
    assert.throws(() => assertConfinedTarget(join(sessions, sid), sid, "other-task"), /^Error: SANDBOX_TARGET_NOT_RUNNING$/);
    // Right task -> accepted, and stageWorkerRef writes the ref into the manifest HOME.
    assertConfinedTarget(join(sessions, sid), sid, TASK);
    const ref = join(root, "ref.md"), body = "valid-sid ref body\n";
    writeFileSync(ref, body);
    const staged = stageWorkerRef(join(sessions, sid), sid, TASK, ref);
    assert.equal(staged, join(home, ".telepty", "shared", `${sha256(body)}.md`));
    assert.equal(readFileSync(staged, "utf8"), body);
  });
});

test("(c) the guard is the module's identity shape: 128 chars and . _ - pass it, 129 chars and a leading dot do not", () => {
  withRoot((_root, sessions) => {
    for (const sid of ["a".repeat(128), "a.b_c-D9", "9"]) {
      const r = recordFs(() => assertConfinedTarget(join(sessions, sid), sid, TASK));
      assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT", sid);
    }
    for (const sid of ["a".repeat(129), ".hidden", "-x", "_x", "", "a b", "a:b"]) {
      const r = recordFs(() => assertConfinedTarget(join(sessions, sid), sid, TASK));
      assert.equal(r.error?.message, "SANDBOX_TARGET_SID", JSON.stringify(sid));
      assert.deepEqual(r.calls, []);
    }
  });
});
