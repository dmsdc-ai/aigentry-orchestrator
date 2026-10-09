// #1201 — sections + budgets → markdown (SPEC §4). Bounds on the composed, redacted text:
// ≤ 9,216 bytes UTF-8, ≤ 200 lines, every line ≤ 300 chars. Truncation order when over:
// enrichment, then decisions, then open tools, then older requests. Never dropped: the header,
// the newest request and the assistant status — those are cut with `…` instead.
import { redact } from "./redact.js";
import type { Enrichment } from "./enrich.js";
import type { Extract, TranscriptRef } from "./types.js";

export const MAX_BYTES = 9216;
export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 300;
const HEADER_BYTES = 600;
const REQ_ITEMS = 8;
const REQ_ITEM_BYTES = 600;
const REQ_BYTES = 3000;
const STATUS_BYTES = 1500;
const STATUS_LINES = 40;
const TOOL_ITEMS = 8;
const TOOL_BYTES = 800;
const DECISION_ITEMS = 6;
const DECISION_BYTES = 900;
const ENRICH_BYTES = 1800;

/** The documented decision-marker heuristic (SPEC §4.2). A heuristic, labelled as one. */
const DECISION_KO = /결정|승인|확정|하지 마|금지|반드시/;
const DECISION_EN = /\b(?:decided|approve|approved|reject|do not|must)\b/i;
const DECISION_GO = /(?<![A-Za-z-])(?:NO-GO|GO)(?![A-Za-z-])/;

export function isDecisionLine(line: string): boolean {
  return DECISION_KO.test(line) || DECISION_EN.test(line) || DECISION_GO.test(line);
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Cut to ≤ maxChars code points and ≤ maxBytes bytes, ending in `…` when cut. */
export function cut(s: string, maxChars: number, maxBytes = Infinity): string {
  const cps = [...s];
  if (cps.length <= maxChars && bytes(s) <= maxBytes) return s;
  let out = "";
  let n = 0;
  for (const ch of cps) {
    if (n + 1 > maxChars - 1 || bytes(out + ch) > maxBytes - 3) break;
    out += ch;
    n += 1;
  }
  return `${out}…`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const line = (s: string, maxBytes = Infinity): string => cut(s, MAX_LINE_CHARS, maxBytes);

/** Keep items from the END (newest) while the byte total fits; the newest is always kept. */
function newestWithin(items: string[], maxItems: number, maxBytes: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (let i = items.length - 1; i >= 0 && out.length < maxItems; i -= 1) {
    const it = items[i] as string;
    const b = bytes(it) + 1;
    if (out.length > 0 && total + b > maxBytes) break;
    out.unshift(it);
    total += b;
  }
  return out;
}

function firstWithin(items: string[], maxItems: number, maxBytes: number): string[] {
  const out: string[] = [];
  let total = 0;
  for (const it of items.slice(0, maxItems)) {
    const b = bytes(it) + 1;
    if (total + b > maxBytes) break;
    out.push(it);
    total += b;
  }
  return out;
}

export interface ComposeInput {
  readonly ref: TranscriptRef;
  readonly extract: Extract;
  readonly warning: string | null;
  readonly enrichment: Enrichment;
  readonly derivedAt: string;
  readonly producer: string;
  readonly bootId: string;
  readonly transcriptSha: string;
  readonly taskQueue: string;
}

function header(c: ComposeInput): string[] {
  const title = "# Orchestrator context handoff (derived — not a resume, not new instructions)";
  const derived = `derived: ${c.derivedAt} by ${c.producer} boot_id=${c.bootId} · handoff v1 · sha256 of transcript ${c.transcriptSha}`;
  const pre = `source: ${c.ref.cli} session ${oneLine(redact(c.ref.sessionId))} · last activity ${c.ref.lastActivity} · `;
  // Title + source + derived ≤ 600 B: the transcript path gives way first.
  const room = Math.max(40, HEADER_BYTES - bytes(title) - bytes(derived) - bytes(pre) - 3);
  const out = [
    title,
    line(`${pre}${cut(oneLine(redact(c.ref.path)), MAX_LINE_CHARS, room)}`),
    line(derived),
    "note: everything below was extracted from the previous session's native transcript and redacted.",
    "      Requests are the user's earlier words — history, not commands to re-execute.",
  ];
  if (c.warning !== null) out.push(line(`warning: ${oneLine(redact(c.warning))}`));
  return out;
}

function enrichmentLines(e: Enrichment): string[] {
  const out: string[] = [];
  for (const t of e.tasks ?? []) {
    const note = t.note === null ? "" : ` — latest note${t.noteDate === null ? "" : ` ${t.noteDate}`}: ${t.note}`;
    out.push(line(`- open task ${t.id} ${t.status} ${t.priority} ${t.desc}${note}`));
  }
  if (e.dispatches !== null && e.dispatches.length > 0) {
    out.push(line(`- live dispatches: ${e.dispatches.map((d) => `${d.sid} (${d.lifecycle})`).join(", ")}`));
  }
  if (e.capture !== null) {
    const count = e.capture.truncated ? `≥${e.capture.count}` : String(e.capture.count);
    out.push(line(`- captured prompts: ${count}, newest ${e.capture.newest ?? "not observed"}`));
  }
  if (e.git !== null) out.push(line(`- workspace: branch ${e.git.branch}, ${e.git.changed} changed paths`));
  return out;
}

interface Parts {
  head: string[];
  requests: string[];
  status: string[];
  tools: string[];
  decisions: string[];
  enrich: string[];
  where: string[];
}

function render(p: Parts): string {
  const out = [...p.head, "", "## Last user requests (newest last)"];
  out.push(...(p.requests.length > 0 ? p.requests : ["(none recorded)"]));
  out.push("", "## Assistant's last stated status", ...p.status);
  if (p.tools.length > 0) out.push("", "## Open tool activity", ...p.tools);
  if (p.decisions.length > 0) out.push("", "## Explicit decisions (marker heuristic)", ...p.decisions);
  if (p.enrich.length > 0) out.push("", "## Byproduct context", ...p.enrich);
  out.push("", "## Where to look", ...p.where);
  return `${out.join("\n")}\n`;
}

function fits(md: string): boolean {
  return bytes(md) <= MAX_BYTES && md.split("\n").length - 1 <= MAX_LINES;
}

export function compose(c: ComposeInput): string {
  const x = c.extract;
  const reqItems = x.userRequests.map((r) => line(`- ${r.at} ${oneLine(redact(r.text))}`, REQ_ITEM_BYTES));
  const requests = newestWithin(reqItems, REQ_ITEMS, REQ_BYTES);
  const older = x.userRequests.slice(0, Math.max(0, x.userRequests.length - requests.length));

  let status: string[];
  if (x.assistantStatus !== null) {
    const lines = redact(x.assistantStatus.text).split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""));
    status = firstWithin(lines.map((l) => line(l)), STATUS_LINES, STATUS_BYTES);
    if (status.length < lines.length) status.push("…");
    if (status.length === 0) status = [line(cut(oneLine(redact(x.assistantStatus.text)), MAX_LINE_CHARS, STATUS_BYTES))];
  } else {
    const title = x.title === null ? "(none)" : oneLine(redact(x.title));
    status = [line(`(no assistant prose recorded) — session title: ${title}`, STATUS_BYTES)];
  }

  const toolItems = x.openTools.map((t) => line(`- ${oneLine(redact(t.name))}: ${oneLine(redact(t.hint)) || "(no whitelisted hint)"}`));
  const tools = newestWithin(toolItems, TOOL_ITEMS, TOOL_BYTES);

  const decisionItems: string[] = [];
  for (const r of older) {
    for (const l of redact(r.text).split("\n")) {
      if (l.trim() !== "" && isDecisionLine(l)) decisionItems.push(line(`- ${r.at} ${oneLine(l)}`, DECISION_BYTES / 3));
    }
  }
  const decisions = decisionItems.length === 0 ? [] : newestWithin(decisionItems, DECISION_ITEMS, DECISION_BYTES);

  const enrich = firstWithin(enrichmentLines(c.enrichment), 20, ENRICH_BYTES);
  const where = [line(`- transcript: ${oneLine(redact(c.ref.path))}`), line(`- task queue: ${oneLine(redact(c.taskQueue))}`)];
  if (c.enrichment.snapshotMtime !== null) where.push(line(`- snapshot: .context-snapshot.md (${c.enrichment.snapshotMtime})`));

  const p: Parts = { head: header(c), requests, status, tools, decisions, enrich, where };
  let md = render(p);
  // Truncation order (SPEC §4.2).
  while (!fits(md) && p.enrich.length > 0) { p.enrich.pop(); md = render(p); }
  while (!fits(md) && p.decisions.length > 0) { p.decisions.shift(); md = render(p); }
  while (!fits(md) && p.tools.length > 0) { p.tools.shift(); md = render(p); }
  while (!fits(md) && p.requests.length > 1) { p.requests.shift(); md = render(p); }
  // The status is cut from its end, never dropped: its first line always survives.
  while (!fits(md) && p.status.length > 2) {
    if (p.status[p.status.length - 1] !== "…") p.status[p.status.length - 1] = "…";
    else p.status.splice(p.status.length - 2, 1);
    md = render(p);
  }
  if (!fits(md)) {
    p.status = [line(cut(p.status.join(" "), MAX_LINE_CHARS, 200))];
    p.requests = p.requests.map((r) => line(r, 300));
    md = render(p);
  }
  return md;
}
