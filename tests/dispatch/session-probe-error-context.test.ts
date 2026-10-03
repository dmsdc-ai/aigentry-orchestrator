import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

// Set PROBE_REPO when running an isolated compilation outside the repository cwd.
// Synthetic text below is never a measurement of a live viewport or task completion.
const repo = resolve(process.env.PROBE_REPO || process.cwd());
const python = process.env.PYTHON || "python3";
const probe = resolve(repo, "bin/session-probe.py");
const info = resolve(repo, "tests/fixtures/session-state/claude-connected.info");
const source = resolve(repo, "tests/dispatch/session-probe-error-context.test.ts");
const positive = resolve(repo, "tests/fixtures/session-state/thinking-block-400.screen");
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
type State = { surface: string; ready: boolean; activity: string;
  detail: { verify_started: boolean; tracker_class: string } };
type Case = { name: string; screen: string; surface?: string; benign?: boolean;
  ready?: boolean; tracker?: string; fixture?: string };
const working = "Working (3s • esc to interrupt)";
const report = "REPORT: explained the thinking block matcher in ordinary prose.";
const cases: Case[] = [
  { name: "checked-in-provider-rejection", screen: readFileSync(positive, "utf8"),
    fixture: positive, surface: "thinking_block", ready: false, tracker: "error" },
  { name: "synthetic-invalid-request", screen: 'API Error: 400 {"type":"invalid_request_error","message":"request rejected"}', surface: "thinking_block", ready: false },
  { name: "synthetic-api-thinking-rejection", screen: "API Error: thinking block cannot be accepted for this request", surface: "thinking_block", ready: false },
  { name: "benign-report", screen: report, benign: true, ready: false },
  { name: "benign-code-explanation", screen: 'The string "thinking block" is an example label.', benign: true, ready: false },
  { name: "benign-report-active", screen: `${report}\n${working}`, surface: "working" },
  { name: "benign-fenced-diagnostic-active", screen: '```text\nAPI Error: invalid_request_error: thinking block rejected\n```\n' + working, surface: "working" },
  { name: "benign-fence-before-tail20", screen: '```text\n' + 'example\n'.repeat(21) + 'invalid_request_error: thinking block rejected\n```\n' + working, surface: "working" },
  { name: "working-control", screen: working, surface: "working", ready: false },
  { name: "trust-control", screen: "Do you trust this folder?\n1. Yes, I trust\n2. No", surface: "modal", ready: false },
  { name: "trust-with-benign-report", screen: `${report}\nDo you trust this folder?\n1. Yes, I trust\n2. No`, surface: "modal", ready: false },
  { name: "sandbox-control", screen: "Would you like to run the following command?\n1. Yes\n2. No", surface: "sandbox_prompt", ready: false },
  { name: "sandbox-with-benign-report", screen: `${report}\nWould you like to run the following command?\n1. Yes\n2. No`, surface: "sandbox_prompt", ready: false },
  { name: "continue-modal-control", screen: "Press Enter to continue", surface: "modal", ready: false },
  { name: "unsubmitted-control", screen: "❯ [context-ref] /shared/abcdef123456.md", surface: "unsubmitted" },
  { name: "unsubmitted-with-benign-report", screen: `${report}\n❯ [context-ref] /shared/abcdef123456.md`, surface: "unsubmitted" },
  { name: "collapsed-old-transcript-unknown", screen: 'SYNTHETIC historical transcript: old report discussed thinking block; old prompt ❯; old answer completed. Current viewport unavailable.', surface: "unknown", ready: false },
];

console.log(JSON.stringify({ kind: "manifest", platform: process.platform, arch: process.arch,
  osRelease: release(), node: process.version, python, cases: cases.length,
  hashes: { probe: sha256(readFileSync(probe)), test: sha256(readFileSync(source)),
    info: sha256(readFileSync(info)), positive: sha256(readFileSync(positive)) } }));

for (const row of cases) {
  test(row.name, (t) => {
    // argparse FileType accepts '-' as stdin on all platforms; no temp files/network.
    const argv = [probe, "--sid", "synthetic-error-context", "--screen-file", "-", "--info-file", info];
    const started = performance.now();
    const result = spawnSync(python, argv, { input: row.screen, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TELEPTY: "offline-probe-forbidden" } });
    t.diagnostic(JSON.stringify({ argv: [python, ...argv], provenance: row.fixture || "SYNTHETIC",
      inputSha256: sha256(row.screen), inputBytes: Buffer.byteLength(row.screen),
      wallMs: performance.now() - started, exit: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
    assert.equal(result.error, undefined, "probe must execute");
    assert.equal(result.status, 0, "probe must exit zero");
    const state = JSON.parse(result.stdout) as State;
    if (row.benign) {
      assert.ok(!["thinking_block", "error"].includes(state.surface),
        `benign text must not be provider error; got ${state.surface}`);
    }
    if (row.surface) assert.equal(state.surface, row.surface, `${row.name}: surface`);
    if (row.ready !== undefined) assert.equal(state.ready, row.ready, `${row.name}: ready`);
    if (row.tracker) assert.equal(state.detail.tracker_class, row.tracker, `${row.name}: tracker`);
    if (row.surface === "working") {
      assert.equal(state.activity, "moving");
      assert.equal(state.detail.verify_started, true);
    } else {
      assert.equal(state.detail.verify_started, false, "no evidence of current task start");
    }
    assert.notEqual(state.detail.tracker_class, "done", "a prompt cannot establish completion");
  });
}
