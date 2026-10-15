// Task 1201 — SPEC §3.3 / §9.2 "Selection": the newest orchestrator session across ALL four
// CLIs by last activity (owner criterion 3), cwd-verified, never by which CLI is booting.
// Driven through `bin/context-handoff.mjs --json` (SPEC §8).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CLIS,
  type Box,
  at,
  dropBox,
  makeBox,
  plant,
  plantAgy,
  plantClaude,
  plantClaudeSubagent,
  runCli,
} from "./harness.js";

type Rec = { outcome: string; warning: string | null; source: { cli: string; session_id: string; path: string; last_activity: string } | null };

function pick(b: Box, args: readonly string[] = []): Rec {
  const r = runCli(b, ["--json", ...args]);
  assert.equal(r.status, 0, `expected a source; exit ${r.status}; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  return JSON.parse(r.stdout) as Rec;
}

test("newest by last activity across the four CLIs — each CLI wins once (criterion 3)", (t) => {
  for (const [i, newest] of CLIS.entries()) {
    const b = makeBox();
    t.after(() => dropBox(b));
    const planted = CLIS.map((cli, j) => plant(cli, b, { last: at(cli === newest ? 40 : 10 + j) }));
    // A FIFTH transcript, newest of all, recorded in another cwd: must be ignored.
    plant(CLIS[(i + 1) % 4], b, { last: at(90), cwd: path.join(b.base, "other-workspace") });
    const rec = pick(b);
    const want = planted[i];
    assert.equal(rec.source?.cli, newest, `newest is ${newest}; picked ${JSON.stringify(rec.source)}`);
    assert.equal(rec.source?.session_id, want.session);
    assert.equal(rec.source?.last_activity, at(40).toISOString());
  }
});

test("last activity is the max record timestamp, not the file mtime (SPEC §3.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const older = plant("codex", b, { last: at(10) });
  const newer = plant("gemini", b, { last: at(20) });
  // Make the OLDER transcript's file the most recently modified one.
  fs.utimesSync(older.file, at(500), at(500));
  fs.utimesSync(newer.file, at(1), at(1));
  assert.equal(pick(b).source?.session_id, newer.session);
});

test("tie-break: equal last activity → cli name ascending, then sessionId ascending (SPEC §3.3.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("grok", b, { last: at(30) });
  plant("codex", b, { last: at(30) });
  assert.equal(pick(b).source?.cli, "codex", "codex < grok");

  const c = makeBox();
  t.after(() => dropBox(c));
  plantClaude(c, { last: at(30), session: "bbbbbbbb-0000-4000-8000-000000000002" });
  plantClaude(c, { last: at(30), session: "aaaaaaaa-0000-4000-8000-000000000001" });
  assert.equal(pick(c).source?.session_id, "aaaaaaaa-0000-4000-8000-000000000001");
});

test("cwd verification ignores a misleading slug, both ways (SPEC §2.1: the slug is not trusted)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  // Filed under THIS workspace's slug, but every record says another cwd: not a candidate.
  plantClaude(b, { last: at(50), cwd: path.join(b.base, "not-this-one"), slug: b.ws.replace(/[^A-Za-z0-9]/g, "-") });
  // Filed under a slug that names nothing, with records whose cwd IS this workspace: a candidate.
  const real = plantClaude(b, { last: at(20), slug: "-some-unrelated-slug" });
  const rec = pick(b);
  assert.equal(rec.source?.session_id, real.session);
});

test("a partial last line is tolerated (SPEC §3.2: skip unparseable lines, never throw)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(20) });
  fs.appendFileSync(p.file, '{"type":"user","cwd":"' + JSON.stringify(b.ws).slice(1, -1) + '","timestamp":"2026-10-09T09:');
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("CH-CLAUDE-REQ-LAST"));
  assert.equal(pick(b).source?.last_activity, at(20).toISOString());
});

test("an oversize transcript is read from its last 8 MiB only (SPEC §3.2 read bound)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(20) });
  const tail = fs.readFileSync(p.file, "utf8");
  const ws = JSON.stringify(b.ws).slice(1, -1);
  // HEAD: a short first line, one record dated far in the future, then ~9 MiB of filler, then
  // the real transcript. A whole-file read would report the future date as last activity (even
  // one that drops its first line); a tail read cannot see it.
  const future = `{"type":"user","cwd":"${ws}","sessionId":"${p.session}","isSidechain":false,"timestamp":"2099-01-01T00:00:00.000Z","origin":{"kind":"human"},"message":{"role":"user","content":"CH-HEAD-ONLY"}}\n`;
  const filler = `{"type":"mode","mode":"${"x".repeat(1000)}"}\n`;
  fs.writeFileSync(p.file, `{"type":"mode","mode":"normal"}\n` + future + filler.repeat(9 * 1024) + tail);
  fs.utimesSync(p.file, at(20), at(20));
  assert.ok(fs.statSync(p.file).size > 9 * 1024 * 1024);
  const rec = pick(b);
  assert.equal(rec.source?.last_activity, at(20).toISOString(), "the head record beyond the 8 MiB tail was not read");
  const md = runCli(b).stdout;
  assert.ok(!md.includes("CH-HEAD-ONLY") && md.includes("CH-CLAUDE-REQ-LAST"));
});

test("--before <ISO> excludes sessions whose FIRST record is at or after it (SPEC §3.3.4)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const prev = plantClaude(b, { last: at(20) });
  const self = plantClaude(b, { last: at(60) });
  const first = firstTimestamp(self.file);
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(pick(b).source?.session_id, self.session, "without --before the newest wins");
  assert.equal(pick(b, ["--before", iso(first)]).source?.session_id, prev.session, "first record == --before is excluded");
  assert.equal(pick(b, ["--before", iso(first - 60_000)]).source?.session_id, prev.session, "first record after --before is excluded");
  assert.equal(pick(b, ["--before", iso(first + 60_000)]).source?.session_id, self.session, "started before --before: still a candidate");
});

/** The earliest record timestamp in a planted claude transcript. */
function firstTimestamp(file: string): number {
  let min = Infinity;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    const ts = (JSON.parse(line) as { timestamp?: string }).timestamp;
    if (typeof ts === "string") min = Math.min(min, Date.parse(ts));
  }
  return min;
}

test("isSidechain records and the subagents/ subtree are excluded (SPEC §3.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const main = plantClaude(b, { last: at(20) });
  plantClaudeSubagent(b, main, at(80));
  const rec = pick(b);
  assert.equal(rec.source?.session_id, main.session);
  assert.ok(!String(rec.source?.path).includes(`${path.sep}subagents${path.sep}`), `a subagent transcript was chosen: ${rec.source?.path}`);
  const md = runCli(b).stdout;
  assert.doesNotMatch(md, /CANARY-CLAUDE-(SIDECHAIN|SUBAGENT)/);
});

test("staleness guard: newer activity in the detect-only agy store warns (SPEC §3.3.3, PHASE0 P0-3)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plant("gemini", b, { last: at(20) });
  plantAgy(b, at(30));
  const rec = pick(b);
  assert.equal(rec.source?.cli, "gemini", "agy is never parsed, so it is never the source");
  assert.match(String(rec.warning), /newer activity in unmeasured .+ store — handoff may not be the latest/);
  assert.match(runCli(b).stdout, /^\[?warning: newer activity in unmeasured .+ store/m, "the warning is in the handoff header");

  const c = makeBox();
  t.after(() => dropBox(c));
  plant("gemini", c, { last: at(20) });
  plantAgy(c, at(10));
  assert.equal(pick(c).warning, null, "an OLDER agy store does not warn");
});

test("agy alone is no source (detect-only): exit 3", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantAgy(b, at(30));
  assert.equal(runCli(b).status, 3);
});

test("win32: the cwd match is case-insensitive (SPEC §3.2)", { skip: process.platform !== "win32" && "NOTRUN off win32: the rule is win32-only; the Windows test job runs it" }, (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plant("claude", b, { last: at(20), cwd: b.ws.toUpperCase() });
  assert.equal(pick(b).source?.session_id, p.session);
});
