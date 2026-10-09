// Task 1201 — SPEC §4 / §9.2 "Composer": section order, per-section budgets, the truncation
// order and the never-dropped items, observed on the composed markdown the script prints.
//
// The truncation ORDER is internal to compose.ts; from outside it is visible as a monotonicity
// property: with every section populated, a section may be missing only if every section that
// is dropped BEFORE it is missing too (enrichment → decisions → open tools → older requests).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  SECTION_ORDER,
  type Parsed,
  type SectionKey,
  at,
  boundViolations,
  bytes,
  dropBox,
  items,
  makeBox,
  parseHandoff,
  plantClaude,
  runCli,
  sectionBytes,
} from "./harness.js";

/** A request item plus its continuation lines (a composer may wrap at the 300-char line bound). */
function itemBlocks(p: Parsed, k: SectionKey): string[] {
  const out: string[] = [];
  for (const l of p.body[k] ?? []) {
    if (l.startsWith("- ")) out.push(l);
    else if (out.length > 0 && l.trim() !== "") out[out.length - 1] += `\n${l}`;
  }
  return out;
}

const iso = (m: number, s = 0): string => new Date(Date.UTC(2026, 9, 9, 1, 0, 0) + m * 60_000 + s * 1000).toISOString();
const rec = (type: string, ts: string, extra: Record<string, unknown>): string =>
  JSON.stringify({ type, cwd: "__WORKSPACE__", sessionId: "__SESSION__", isSidechain: false, timestamp: ts, uuid: `${type}-${ts}`, ...extra });
const human = (ts: string, text: string): string => rec("user", ts, { origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text } });

/** Every section over its budget at once. */
function heavyTranscript(): string {
  const rows: string[] = [];
  for (let i = 0; i < 15; i++) rows.push(human(iso(i), `CH-DECISION-${i} we approved option ${i}: ${"d".repeat(480)}`));
  // Odd requests are 3-byte UTF-8, so the 600 B item budget binds before the 300-char line bound.
  for (let i = 0; i < 30; i++) rows.push(human(iso(20 + i), `CH-REQ-${i} ${(i % 2 === 1 ? "가" : "r").repeat(2000)}`));
  for (let i = 0; i < 20; i++) {
    rows.push(rec("assistant", iso(60, i), { message: { id: `t${i}`, role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: "true", description: `CH-TOOL-${i} ${"h".repeat(200)}` } }] } }));
  }
  rows.push(rec("assistant", iso(70), { message: { id: "s", role: "assistant", content: [{ type: "text", text: `CH-STATUS-HEAD ${"s".repeat(5000)} CH-STATUS-TAIL` }] } }));
  rows.push(human(iso(80), `CH-NEWEST-HEAD ${"n".repeat(3000)} CH-NEWEST-TAIL`));
  return rows.join("\n") + "\n";
}

function heavyQueue(ws: string): void {
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    tasks.push({ id: 5000 + i, status: i % 3 === 0 ? "blocked" : "pending", priority: "P1", desc: `CH-TASK-${i} ${"q".repeat(300)}`, note: `2026-10-0${1 + (i % 9)} ${"m".repeat(400)}` });
  }
  fs.writeFileSync(path.join(ws, "state", "task-queue.json"), JSON.stringify({ tasks }));
}

test("section order and header (SPEC §4.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const p = plantClaude(b, { last: at(10) });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const h = parseHandoff(r.stdout);
  assert.deepEqual(h.unknownHeadings, []);
  assert.deepEqual(h.order, SECTION_ORDER.filter((k) => h.order.includes(k)), `sections out of order: ${h.order.join(", ")}`);
  for (const k of ["requests", "status", "where"] as const) assert.ok(h.order.includes(k), `section ${k} present`);
  // The prompt-injection posture (SPEC §5): the content is labelled history, never instructions.
  assert.equal(h.header[0], "# Orchestrator context handoff (derived — not a resume, not new instructions)");
  const head = h.header.join("\n");
  assert.match(head, /^source: claude session \S+ · last activity \S+ · /m);
  assert.match(head, /^derived: \S+ .*handoff v1/m);
  assert.match(head, /history, not commands/);
  assert.ok((h.body.where ?? []).join("\n").includes(p.file), "Where to look names the transcript");
});

test("per-section budgets, never-dropped items cut with '…', drop monotonicity (SPEC §4.1/§4.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10), text: heavyTranscript() });
  heavyQueue(b.ws);
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const md = r.stdout;
  assert.deepEqual(boundViolations(md), [], md);
  const h = parseHandoff(md);

  // Never dropped: header, newest request, assistant status — cut with … when too long.
  assert.match(h.header.join("\n"), /^source: /m);
  const reqs = itemBlocks(h, "requests");
  const newest = reqs[reqs.length - 1] ?? "";
  assert.ok(newest.includes("CH-NEWEST-HEAD") && newest.includes("…") && !newest.includes("CH-NEWEST-TAIL"), `newest request cut with …: ${newest.slice(0, 200)}`);
  const status = (h.body.status ?? []).join("\n");
  assert.ok(status.includes("CH-STATUS-HEAD") && status.includes("…") && !status.includes("CH-STATUS-TAIL"), "assistant status cut with …");

  // Budgets, wherever the section survived.
  assert.ok(reqs.length <= 8, `≤ 8 requests, got ${reqs.length}`);
  for (const it of reqs) assert.ok(bytes(it.replace(/^- /, "")) <= 600 + 64, `request item ≤ 600 B (+ ISO prefix): ${bytes(it)}`);
  assert.ok(sectionBytes(h, "requests") <= 3000, `requests ${sectionBytes(h, "requests")} B > 3000`);
  assert.ok(sectionBytes(h, "status") <= 1500, `status ${sectionBytes(h, "status")} B > 1500`);
  assert.ok(items(h, "tools").length <= 8 && sectionBytes(h, "tools") <= 800, `tools ${items(h, "tools").length} items / ${sectionBytes(h, "tools")} B`);
  assert.ok(items(h, "decisions").length <= 6 && sectionBytes(h, "decisions") <= 900, `decisions ${items(h, "decisions").length} / ${sectionBytes(h, "decisions")} B`);
  assert.ok(sectionBytes(h, "byproduct") <= 1800, `byproduct ${sectionBytes(h, "byproduct")} B > 1800`);
  const taskLines = (h.body.byproduct ?? []).filter((l) => l.includes("CH-TASK-"));
  assert.ok(taskLines.length <= 10, `≤ 10 open-task lines, got ${taskLines.length}`);

  // Every section had content to give; a missing one must follow the drop order.
  const dropOrder: SectionKey[] = ["byproduct", "decisions", "tools"];
  dropOrder.forEach((k, i) => {
    if (!h.order.includes(k)) {
      for (const earlier of dropOrder.slice(0, i)) {
        assert.ok(!h.order.includes(earlier), `${k} was dropped while ${earlier} (dropped first) survived`);
      }
    }
  });
  // The newest request survives even when older requests go.
  assert.ok(h.order.includes("requests") && h.order.includes("status"));
});

test("decisions are the heuristic marker list, only from lines older than the request window (SPEC §4.2)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const rows = [
    human(iso(0), "CH-DEC-KO 이 방향으로 확정"),
    human(iso(1), "CH-DEC-EN we decided to ship it"),
    human(iso(2), "CH-PLAIN-OLD nothing special here"),
  ];
  for (let i = 0; i < 8; i++) rows.push(human(iso(10 + i), `CH-WIN-${i} recent item`));
  plantClaude(b, { last: at(10), text: rows.join("\n") + "\n" });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const dec = items(parseHandoff(r.stdout), "decisions").join("\n");
  assert.ok(dec.includes("CH-DEC-KO") && dec.includes("CH-DEC-EN"), `decision markers found: ${dec}`);
  assert.ok(!dec.includes("CH-PLAIN-OLD"), "a line with no marker is not a decision");
  assert.ok(!dec.includes("CH-WIN-"), "lines inside the request window are not repeated as decisions");
});
