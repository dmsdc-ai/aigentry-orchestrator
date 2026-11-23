// #1303 D2 — the sealed worker environment's TERM. The worker always runs in a real PTY, so an
// inherited TERM of `dumb` (a controller tool shell, e.g. Codex's) or an empty/unset one is sealed as
// xterm-256color; any other inherited value is kept.
//
// WHAT THIS ATTESTS, exactly: the TERM in the SEALED launch environment (the hash-verified manifest's
// env, read through readSealedManifest as the runner reads it). It does NOT attest the TERM the CLI
// finally sees: worker-sandbox-runner.ts:15 starts the worker with { ...m.env, ...wrapped.env,
// ...secretEnv }, so a sandbox-runtime whose wrapped.env set TERM would override the sealed value. No
// such override is known for the pinned runtime; the effective TERM is verified on Linux in the release
// owner's controlled launch (task 1303 Linux verification), not here.
//
// Same seam as worker-sandbox-providers.test.ts: the REAL compiled loadWorkerScope + prepareWorkerSandbox
// through tests/dispatch/agent-metadata/support/prepare-sandbox.mjs, with a FAKE host HOME, FAKE
// credentials and FAKE CLIs, in an explicit child env. The launcher and the runner are never executed.
// win32: the confined sandbox is unsupported by design; the test asserts the REAL
// SANDBOX_PLATFORM_UNSUPPORTED refusal there (fail closed), never Windows support.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFINED_CLIS, readSealedManifest } from "../../src/session/worker-sandbox.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DIST = join(REPO_ROOT, "dist");
const DRIVER = join(REPO_ROOT, "tests", "dispatch", "agent-metadata", "support", "prepare-sandbox.mjs");
const TASK = "1303";
const WIN = process.platform === "win32";

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface World { root: string; host: string; bin: string; project: string }
function world(): World {
  const root = mkdtempSync(join(tmpdir(), "worker-term-1303-"));
  roots.push(root);
  const w = (p: string, d: string, m?: number): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d, m === undefined ? undefined : { mode: m });
  };
  const host = join(root, "host"), bin = join(root, "bin");
  // Fake CLIs are only resolved on PATH and sealed; they are never launched here.
  for (const c of CONFINED_CLIS) w(join(bin, c), `#!${process.execPath}\nprocess.exit(0);\n`, 0o755);
  w(join(host, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-1303-NOT-A-SECRET" } }), 0o600);
  w(join(host, ".codex", "auth.json"), JSON.stringify({ fake: "FAKE-1303-NOT-A-SECRET" }), 0o600);
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  return { root, host, bin, project: join(root, "project") };
}

/** Seal one codex worker with the given inherited TERM (undefined = unset); returns the sealed env.TERM. */
function sealedTerm(W: World, sid: string, term: string | undefined): { status: number | null; out: string; term: unknown } {
  const scopeFile = join(W.root, `scope-${sid}.json`), stagingRoot = join(W.root, "sessions", sid);
  writeFileSync(scopeFile, JSON.stringify({ version: 1, task: TASK, sid, read: [W.project], write: [W.project], domains: [] }));
  mkdirSync(stagingRoot, { recursive: true });
  const env: Record<string, string> = {
    PATH: `${W.bin}${WIN ? ";" : ":/usr/bin:/bin"}`, HOME: W.host, TMPDIR: join(W.root, "tmp"), LANG: "en_US.UTF-8",
    AGENT_METADATA_DIST: DIST,
    ...(term === undefined ? {} : { TERM: term }),
    ...(WIN ? { USERPROFILE: W.host, TEMP: join(W.root, "tmp"), TMP: join(W.root, "tmp"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } : {}),
  };
  const r = spawnSync(process.execPath, [DRIVER, JSON.stringify({ scopeFile, task: TASK, sid, cli: "codex",
    roleCwd: W.project, argv: ["codex"], stagingRoot })], { encoding: "utf8", env, timeout: 30000 });
  const out = r.stdout + r.stderr;
  if (r.status !== 0) return { status: r.status, out, term: undefined };
  const res = JSON.parse(r.stdout.trim()) as { manifest: string; hash: string };
  // The hash-verified read the runner itself uses: this is the sealed launch env, before wrapped.env.
  const sealed = readSealedManifest(res.manifest, res.hash).m;
  return { status: r.status, out, term: sealed.env.TERM };
}

test("sealed launch env TERM: inherited dumb and unset/empty are sealed as xterm-256color; a normal value is kept", () => {
  const W = world();
  const cases: Array<[string, string | undefined, string]> = [
    ["dumb", "dumb", "xterm-256color"],
    ["unset", undefined, "xterm-256color"],
    ["empty", "", "xterm-256color"],
    ["normal", "screen-256color", "screen-256color"],
  ];
  for (const [label, inherited, want] of cases) {
    const p = sealedTerm(W, `term-${label}`, inherited);
    if (WIN) {
      assert.notEqual(p.status, 0, p.out);
      assert.match(p.out, /SANDBOX_PLATFORM_UNSUPPORTED/);
      continue;
    }
    assert.equal(p.status, 0, `${label}: ${p.out}`);
    assert.equal(p.term, want, `${label}: inherited TERM=${String(inherited)} sealed as ${String(p.term)}`);
  }
});
