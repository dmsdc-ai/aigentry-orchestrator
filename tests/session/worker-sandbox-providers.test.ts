// #1206 S1-D code-owned provider egress per confined CLI: the sealed manifest's allowedDomains is
// unique(scope.domains ∪ PROVIDER_DOMAINS[cli]). Scope domains are task extras (an empty list allowed).
//
// Drives the REAL compiled loadWorkerScope + prepareWorkerSandbox through the existing
// tests/dispatch/agent-metadata/support/prepare-sandbox.mjs driver, with a FAKE host HOME, FAKE
// credentials and FAKE CLIs. The launcher and the runner are never executed: nothing starts a provider
// CLI, reads the developer HOME or touches the network. These tests prove the sealed egress list and its
// hash coverage only, never that a provider accepts the connection or that the OS proxy enforces it.
// win32: the confined sandbox is unsupported by design; the integration tests assert the REAL
// SANDBOX_PLATFORM_UNSUPPORTED refusal (fail closed), never Windows support. The pure constant tests run
// on every OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFINED_CLIS, PROVIDER_DOMAINS, digest, readSealedManifest } from "../../src/session/worker-sandbox.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DIST = join(REPO_ROOT, "dist");
const DRIVER = join(REPO_ROOT, "tests", "dispatch", "agent-metadata", "support", "prepare-sandbox.mjs");
const TASK = "1206";
const WIN = process.platform === "win32";
// Pinned literally (not read from the module under test): a drift in the code-owned list must fail here.
const CLAUDE_HOSTS = ["api.anthropic.com:443", "claude.ai:443", "platform.claude.com:443",
  "statsig.anthropic.com:443", "console.anthropic.com:443"];
const CODEX_HOSTS = ["chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443", "*.oaiusercontent.com:443"];
const HOSTS: Record<string, string[]> = { claude: CLAUDE_HOSTS, codex: CODEX_HOSTS };
const OTHER: Record<string, string[]> = { claude: CODEX_HOSTS, codex: CLAUDE_HOSTS };

type Json = Record<string, unknown>;
const parse = (s: string): Json | null => { try { return JSON.parse(s) as Json; } catch { return null; } };

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface World { root: string; host: string; bin: string; project: string }
function world(): World {
  const root = mkdtempSync(join(tmpdir(), "worker-providers-1206-"));
  roots.push(root);
  const w = (p: string, d: string, m?: number): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d, m === undefined ? undefined : { mode: m });
  };
  const host = join(root, "host"), bin = join(root, "bin");
  // Fake CLIs are only resolved on PATH and sealed; they are never launched here.
  for (const c of CONFINED_CLIS) w(join(bin, c), `#!${process.execPath}\nprocess.exit(0);\n`, 0o755);
  w(join(host, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-1206-NOT-A-SECRET" } }), 0o600);
  w(join(host, ".codex", "auth.json"), JSON.stringify({ fake: "FAKE-1206-NOT-A-SECRET" }), 0o600);
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  return { root, host, bin, project: join(root, "project") };
}

// Explicit env only: no ambient auth, developer HOME, CODEX_HOME or AIGENTRY_CLAUDE_OAUTH_TOKEN reaches the child.
const env = (W: World): Record<string, string> => ({
  PATH: `${W.bin}${WIN ? ";" : ":/usr/bin:/bin"}`, HOME: W.host, TMPDIR: join(W.root, "tmp"), LANG: "en_US.UTF-8",
  AGENT_METADATA_DIST: DIST,
  ...(WIN ? { USERPROFILE: W.host, TEMP: join(W.root, "tmp"), TMP: join(W.root, "tmp"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } : {}),
});

interface Prep { status: number | null; out: string; error: string | null; manifest: string; hash: string; m: Json }
function prepare(W: World, sid: string, cli: string, domains: string[]): Prep {
  const scopeFile = join(W.root, `scope-${sid}.json`), stagingRoot = join(W.root, "sessions", sid);
  writeFileSync(scopeFile, JSON.stringify({ version: 1, task: TASK, sid, read: [W.project], write: [W.project], domains }));
  mkdirSync(stagingRoot, { recursive: true });
  const r = spawnSync(process.execPath, [DRIVER, JSON.stringify({ scopeFile, task: TASK, sid, cli, roleCwd: W.project,
    argv: [cli], stagingRoot })], { encoding: "utf8", env: env(W), timeout: 30000 });
  const res = parse(r.stdout.trim());
  const line = /^Error: (.*)$/m.exec(r.stderr);
  const manifest = res ? String(res.manifest) : "", hash = res ? String(res.hash) : "";
  return { status: r.status, out: r.stdout + r.stderr, error: line ? line[1] ?? null : null, manifest, hash,
    m: manifest ? (parse(readFileSync(manifest, "utf8")) ?? {}) : {} };
}
const allowed = (p: Prep): unknown => ((p.m.config as Json).network as Json).allowedDomains;

test("CONFINED_CLIS and PROVIDER_DOMAINS: exact code-owned lists, one entry per confined CLI, disjoint", () => {
  assert.deepEqual([...CONFINED_CLIS], ["claude", "codex"]);
  assert.deepEqual(Object.keys(PROVIDER_DOMAINS).sort(), [...CONFINED_CLIS].sort());
  assert.deepEqual([...PROVIDER_DOMAINS.claude], CLAUDE_HOSTS);
  assert.deepEqual([...PROVIDER_DOMAINS.codex], CODEX_HOSTS);
  assert.ok(!CLAUDE_HOSTS.some((h) => CODEX_HOSTS.includes(h)));
  // Same shape loadWorkerScope admits for task extras: HTTPS public hostnames, optional leading `*.` wildcard.
  for (const h of [...CLAUDE_HOSTS, ...CODEX_HOSTS]) assert.match(h, /^(?:\*\.)?[a-z0-9][a-z0-9.-]*:443$/);
});

for (const cli of ["claude", "codex"]) {
  test(`${cli}: an empty scope seals exactly PROVIDER_DOMAINS.${cli}; no other provider's host leaks in`, () => {
    const W = world(), p = prepare(W, `e-${cli}`, cli, []);
    if (WIN) { assert.notEqual(p.status, 0, p.out); return assert.equal(p.error, "SANDBOX_PLATFORM_UNSUPPORTED"); }
    assert.equal(p.status, 0, p.out);
    assert.equal(p.m.cli, cli);
    assert.deepEqual(allowed(p), HOSTS[cli]);
    for (const h of OTHER[cli] ?? []) assert.ok(!(allowed(p) as string[]).includes(h), `${h} leaked into ${cli}`);
  });

  test(`${cli}: scope extras are kept first, then provider hosts, deduplicated; no other provider's host leaks in`, () => {
    const W = world();
    const own = HOSTS[cli]![1]!, extras = ["registry.npmjs.org:443", own, "registry.npmjs.org:443", "*.example.org:443"];
    const p = prepare(W, `x-${cli}`, cli, extras);
    if (WIN) { assert.notEqual(p.status, 0, p.out); return assert.equal(p.error, "SANDBOX_PLATFORM_UNSUPPORTED"); }
    assert.equal(p.status, 0, p.out);
    assert.deepEqual(allowed(p), ["registry.npmjs.org:443", own, "*.example.org:443",
      ...HOSTS[cli]!.filter((h) => h !== own)]);
    for (const h of OTHER[cli] ?? []) assert.ok(!(allowed(p) as string[]).includes(h), `${h} leaked into ${cli}`);
  });

  test(`${cli}: the manifest hash covers the sealed allowedDomains; editing them is refused as changed`, () => {
    const W = world(), p = prepare(W, `h-${cli}`, cli, ["registry.npmjs.org:443"]);
    if (WIN) { assert.notEqual(p.status, 0, p.out); return assert.equal(p.error, "SANDBOX_PLATFORM_UNSUPPORTED"); }
    assert.equal(p.status, 0, p.out);
    const raw = readFileSync(p.manifest, "utf8");
    assert.equal(digest(raw), p.hash);
    const current = parse(readFileSync(join(W.root, "sessions", `h-${cli}`, "sandbox-current.json"), "utf8")) ?? {};
    assert.deepEqual(current, { manifest: p.manifest, hash: p.hash });
    const sealed = readSealedManifest(p.manifest, p.hash).m;
    assert.deepEqual(sealed.config.network?.allowedDomains, ["registry.npmjs.org:443", ...HOSTS[cli]!]);
    // Widening (another provider's host) or narrowing (drop one) the sealed list changes the digest.
    for (const edit of [[...HOSTS[cli]!, OTHER[cli]![0]!], HOSTS[cli]!.slice(1)]) {
      const m = JSON.parse(raw) as Json;
      ((m.config as Json).network as Json).allowedDomains = ["registry.npmjs.org:443", ...edit];
      writeFileSync(p.manifest, JSON.stringify(m, null, 2) + "\n");
      assert.notEqual(digest(readFileSync(p.manifest, "utf8")), p.hash);
      assert.throws(() => readSealedManifest(p.manifest, p.hash), /SANDBOX_MANIFEST_CHANGED/);
    }
    writeFileSync(p.manifest, raw);
    assert.equal(readSealedManifest(p.manifest, p.hash).m.cli, cli);
  });
}
