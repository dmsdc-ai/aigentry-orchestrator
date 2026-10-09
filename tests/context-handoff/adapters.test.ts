// Task 1201 — SPEC §3.2 / §9.2: the four transcript adapters, driven against the synthetic
// Phase-0 fixtures through `bin/context-handoff.mjs` (§8) — the engine's black-box surface.
//
// What is pinned per CLI: the right content reaches the right section (`CH-*` markers), and
// nothing from a never-copied field does (`CANARY-*` markers: reasoning/thinking, tool output,
// raw tool input, attachments, system/developer text). See tests/fixtures/context-handoff/README.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CLIS,
  type Cli,
  at,
  boundViolations,
  dropBox,
  items,
  loadAdapters,
  makeBox,
  parseHandoff,
  plant,
  plantClaude,
  runCli,
  runCliRaw,
  sha256File,
} from "./harness.js";

const NEWEST: Record<Cli, string> = {
  claude: "CH-CLAUDE-REQ-LAST",
  codex: "CH-CODEX-REQ-LAST",
  gemini: "CH-GEMINI-REQ-LAST",
  grok: "CH-GROK-REQ-LAST",
};
const STATUS: Record<Cli, string> = {
  claude: "CH-CLAUDE-STATUS",
  codex: "CH-CODEX-STATUS",
  gemini: "CH-GEMINI-STATUS:",
  grok: "CH-GROK-STATUS:",
};

test("ADAPTERS: the four CLIs, all measured after Phase 0, with env-overridable roots (SPEC §3.1/§3.2)", async () => {
  const adapters = await loadAdapters();
  assert.deepEqual(adapters.map((a) => a.cli).sort(), [...CLIS].sort());
  for (const a of adapters) {
    // PHASE0-MEASUREMENTS.md: claude, codex, gemini-cli and grok are measured; agy is
    // detect-only INSIDE the gemini store, not a fifth parsing adapter.
    assert.equal(a.status, "measured", `${a.cli}: Phase 0 measured this store`);
    for (const fn of ["roots", "list", "extract"] as const) assert.equal(typeof a[fn], "function", `${a.cli}.${fn}`);
  }
  const by = (cli: Cli) => adapters.find((a) => a.cli === cli)!;
  const h = path.resolve("/fixture-home");
  const under = (roots: readonly string[], prefix: string) => roots.some((r) => path.resolve(r).startsWith(path.resolve(prefix)));
  const env = { HOME: h, USERPROFILE: h };
  assert.ok(under(by("claude").roots(env), path.join(h, ".claude")), "claude: ~/.claude/projects");
  assert.ok(under(by("claude").roots({ ...env, CLAUDE_CONFIG_DIR: "/cfg" }), path.resolve("/cfg")), "claude: $CLAUDE_CONFIG_DIR/projects");
  assert.ok(under(by("codex").roots(env), path.join(h, ".codex")), "codex: ~/.codex/sessions");
  assert.ok(under(by("codex").roots({ ...env, CODEX_HOME: "/cx" }), path.resolve("/cx")), "codex: $CODEX_HOME/sessions");
  assert.ok(under(by("gemini").roots(env), path.join(h, ".gemini")), "gemini: ~/.gemini");
  assert.ok(under(by("gemini").roots({ ...env, GEMINI_CLI_HOME: "/gh" }), path.join(path.resolve("/gh"), ".gemini")), "gemini: $GEMINI_CLI_HOME/.gemini");
  assert.ok(under(by("grok").roots(env), path.join(h, ".grok")), "grok: ~/.grok/sessions");
});

for (const cli of CLIS) {
  test(`${cli}: newest request and assistant status are carried; never-copied fields are not (SPEC §3.2, §5)`, (t) => {
    const b = makeBox();
    t.after(() => dropBox(b));
    const p = plant(cli, b, { last: at(10) });
    const r = runCli(b);
    assert.equal(r.status, 0, `exit 0 when a handoff was printed; stderr: ${r.stderr}`);
    const md = r.stdout;
    const h = parseHandoff(md);
    assert.match(h.header.join("\n"), /^# Orchestrator context handoff/m);
    assert.ok(h.header.some((l) => l.startsWith(`source: ${cli} session ${p.session}`)), `source line names ${cli} ${p.session}:\n${md}`);
    // The source: line may elide a long path to keep title+source+derived ≤ 600 B (SPEC §4.2:
    // the header is never dropped, it is cut with …); the full path is in "Where to look".
    assert.ok((h.body.where ?? []).join("\n").includes(p.file), `"Where to look" names the transcript path ${p.file}:\n${md}`);
    assert.ok((h.body.requests ?? []).join("\n").includes(NEWEST[cli]), `${NEWEST[cli]} in Last user requests:\n${md}`);
    assert.ok((h.body.status ?? []).join("\n").includes(STATUS[cli]), `${STATUS[cli]} in the assistant status:\n${md}`);
    // Requests are newest last (SPEC §4.2).
    const reqs = items(h, "requests");
    assert.ok(reqs.length > 0 && reqs[reqs.length - 1].includes(NEWEST[cli]), `newest request is the last item: ${reqs.join(" | ")}`);
    assert.doesNotMatch(md, /CANARY-/, `a never-copied field leaked:\n${md}`);
    assert.deepEqual(boundViolations(md), []);
  });
}

test("claude: request window, queued dedupe, decisions, open tools and whitelisted hints (SPEC §3.2, §4.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10) });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const h = parseHandoff(r.stdout);
  const reqs = items(h, "requests");
  assert.ok(reqs.length <= 8, `≤ 8 request items, got ${reqs.length}`);
  // The 8 newest human/queued requests: REQ-03..08, the queued one, REQ-LAST.
  for (const m of ["CH-CLAUDE-REQ-03", "CH-CLAUDE-REQ-08", "CH-CLAUDE-QUEUED", "CH-CLAUDE-REQ-LAST"]) {
    assert.ok(reqs.some((l) => l.includes(m)), `${m} in the request window: ${reqs.join(" | ")}`);
  }
  for (const m of ["CH-CLAUDE-OLD-1", "CH-CLAUDE-OLD-2"]) {
    assert.ok(!reqs.some((l) => l.includes(m)), `${m} is older than the 8-item window`);
  }
  // A queued message is recorded twice (queue-operation enqueue + attachment.queued_command,
  // same text and timestamp); it is ONE request.
  assert.equal(r.stdout.split("CH-CLAUDE-QUEUED").length - 1, 1, "queued message deduplicated");
  // HEURISTIC (SPEC §4.2, labelled as such): a decision-marker line older than the window.
  assert.ok(items(h, "decisions").some((l) => l.includes("CH-CLAUDE-DECISION")), `decision line:\n${r.stdout}`);
  // tool_use without a tool_result is open; the one with a result is not. Hints are
  // whitelisted fields (Bash description), never the raw input.
  const tools = items(h, "tools");
  assert.ok(tools.some((l) => l.includes("Bash") && l.includes("CH-CLAUDE-TOOLHINT")), `open Bash tool with its description: ${tools.join(" | ")}`);
  assert.ok(!tools.some((l) => l.includes("CH-CLAUDE-READHINT")), "a tool_use WITH a tool_result is not open");
  assert.ok(!r.stdout.includes("rm -rf") && !r.stdout.includes("echo CANARY"), "raw Bash input never copied");
});

test("claude: no assistant text block → the '(no assistant prose recorded)' fallback with the title (SPEC §2.1 gap)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(5), template: "no-text.jsonl" });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const h = parseHandoff(r.stdout);
  const status = (h.body.status ?? []).join("\n");
  assert.match(status, /\(no assistant prose recorded\)/);
  assert.ok(status.includes("CH-CLAUDE-NT-TITLE"), `fallback names the session title: ${status}`);
  assert.ok(items(h, "tools").some((l) => l.includes("Edit") && l.includes("CH-NT-EDITHINT")), "open Edit tool with its file_path hint");
  assert.doesNotMatch(r.stdout, /CANARY-/);
});

test("codex: an unanswered function_call is an open tool; answered calls are not", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("codex", b, { last: at(10) });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const tools = items(parseHandoff(r.stdout), "tools");
  assert.ok(tools.some((l) => l.includes("shell")), `open 'shell' call: ${tools.join(" | ")}`);
  assert.ok(!tools.some((l) => l.includes("apply_patch")), "custom_tool_call with an output is not open");
  assert.doesNotMatch(r.stdout, /CANARY-/);
});

test("--json prints the latest.json-shaped record (SPEC §6.4, §8)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plant("codex", b, { last: at(10) });
  const r = runCli(b, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rec).sort(), ["boot_id", "delivery", "handoff", "outcome", "source", "v", "warning", "written_at"]);
  assert.equal(rec.v, 1);
  const src = rec.source as Record<string, unknown>;
  assert.deepEqual(Object.keys(src).sort(), ["bytes", "cli", "last_activity", "path", "session_id", "sha256"]);
  assert.equal(src.cli, "codex");
  assert.equal(src.session_id, p.session);
  assert.equal(src.path, p.file);
  assert.equal(src.last_activity, at(10).toISOString());
  assert.equal(src.sha256, sha256File(p.file), "the transcript is hashed whole when ≤ 64 MiB");
  const ho = rec.handoff as Record<string, unknown>;
  assert.deepEqual(Object.keys(ho).sort(), ["bytes", "lines", "sha256"]);
  assert.ok(typeof ho.bytes === "number" && ho.bytes <= 9216 && typeof ho.lines === "number" && ho.lines <= 200);
  assert.match(String(ho.sha256), /^[0-9a-f]{64}$/);
  assert.equal(rec.warning, null);
});

test("exit codes: 3 when there is no source, 2 on invalid invocation, nothing written (SPEC §8)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const none = runCli(b);
  assert.equal(none.status, 3, `empty stores → 3; stdout: ${none.stdout} stderr: ${none.stderr}`);
  // A transcript recorded in ANOTHER cwd is not a source for this workspace.
  plant("claude", b, { last: at(10), cwd: path.join(b.base, "elsewhere") });
  assert.equal(runCli(b).status, 3, "other-cwd transcript is no source");
  for (const argv of [["--bogus"], ["--workspace", "relative/path"], ["--workspace", b.ws, "--before", "not-a-date"], ["--workspace"]]) {
    const r = runCliRaw(b, argv);
    assert.equal(r.status, 2, `${argv.join(" ")} → 2, got ${r.status}; stderr: ${r.stderr}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(b.ws, "state")), [], "the script never writes without --write");
});
