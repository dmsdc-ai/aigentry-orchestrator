// Task 1291 + 1294 (unit U11) — test-only fake telepty for the controller-link two-store simulation
// (tests/controller-link/simulation.test.ts). Not a test file itself (no `.test.` in the name).
//
// It stands in for the two telepty daemons and the link between them. Each controller ("endpoint")
// has a prompt queue (what its AI session would be shown), a fake audit log (the rows of
// `telepty injects --json`, read through U6's AuditReader port) and a local-notice log. Sends reach
// it through two front ends that share one delivery path:
//   - `runner(label)`: the U3 ProcessRunner port given to the in-process CLI (U6) and pump (U8);
//   - `SPOOL_SCRIPT`: a node script used as the TELEPTY binary of the real dispatch subprocess (U5).
//     It records its argv and prints the answer it was told; `drainSpool` then carries the text.
// The test controls every send: deliver, queued (busy receiver), refuse definitely (the exact
// `❌ [TRACKING_PERSISTENCE_FAILED]` line that U3 classifies as a definite refusal), lost or
// delayed after an uncertain answer, delay, drop and duplicate. It reads envelopes only to log
// them and to match rules; it never decides anything controller-link decides.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { AuditReader, AuditRow } from "../../src/controller-link/cli.js";
import { parseEnvelope } from "../../src/controller-link/envelope.js";
import type { ProcessRunner } from "../../src/controller-link/send.js";
import type { InjectResult } from "../../src/report/pump.js";

/**
 * What the fake does with one send.
 * deliver            handed over and shown to the receiving session now
 * queued             handed over, `QUEUED, NOT consumed` (busy receiver), shown now, audit `queued`
 * refuse             `❌ [TRACKING_PERSISTENCE_FAILED]`, exit 1: nothing reaches the receiver
 * lost               uncertain answer (timeout kill in process, `socket hang up` exit 1 in the subprocess); nothing arrives
 * uncertain_delayed  uncertain answer, but the text arrives `delayMs` later
 * delay              handed over, but the text arrives `delayMs` later
 * drop               handed over and logged by the receiving daemon, but the session never sees it
 * duplicate          handed over and shown twice (two audit rows, same bytes)
 * hang               subprocess only: telepty never answers (the test then kills the sender); nothing arrives
 */
export type DeliveryMode = "deliver" | "queued" | "refuse" | "lost" | "uncertain_delayed" | "delay" | "drop" | "duplicate" | "hang";

/** SPEC §6.1 step 2 / TEST-PLAN C7: every send is `inject --submit --no-submit-force --submit-retry 0 --from controller-link <target> <envelope>`. */
export const C7_PREFIX: readonly string[] = ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "controller-link"];
/** The receiving daemon's 500 of incident 1, in the `❌ [<CODE>]` form U3 classifies as `refused_definite`. */
export const DEFINITE_REFUSAL_LINE = "❌ [TRACKING_PERSISTENCE_FAILED] no task bytes were delivered";
const CONSUMED_LINE = "✅ Submitted — consumed as a new turn.";
const QUEUED_LINE = "⏳ QUEUED, NOT consumed";

export interface Rule {
  from?: string;
  kind?: string;
  ref?: string;
  mode: DeliveryMode;
  delayMs?: number;
  /** How many matching sends this rule takes (default 1). */
  count?: number;
}

export interface Choice {
  mode: DeliveryMode;
  delayMs: number;
}

export interface Endpoint {
  label: string;
  /** The telepty peer name other controllers address (`<sid>@<host>`). */
  host: string;
  sid: string;
  /** Texts shown to this controller's session, oldest first (envelopes with a provenance banner, and local notices). */
  prompts: string[];
  /** This machine's telepty audit log. */
  audit: AuditRow[];
  /** Local notices posted to this controller by its own pump. */
  notices: Array<{ at: number; text: string }>;
  /** Until this time the daemon answers every inject with the definite refusal. */
  downUntil: number;
  /** Until this time the session is busy: injects are answered `QUEUED, NOT consumed`. */
  busyUntil: number;
}

export interface SendRecord {
  n: number;
  from: string;
  to: string | null;
  via: "cli" | "dispatch";
  mode: DeliveryMode;
  at: number;
  kind: string;
  id: string;
  seq: number;
  ref: string | null;
  state: string | null;
  sha256: string;
  text: string;
}

export interface Answer {
  rc: number | null;
  stdout: string;
  stderr: string;
}

export type SpoolAnswer = { rc: number; stdout: string; stderr: string } | { hang: string };

interface Delayed {
  to: Endpoint;
  from: string;
  text: string;
  releaseAt: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The telepty output for a mode. A subprocess cannot exit without a status, so its uncertain answer is `socket hang up`, exit 1. */
export function answerFor(mode: DeliveryMode, subprocess: boolean): Answer {
  switch (mode) {
    case "deliver":
    case "delay":
    case "drop":
    case "duplicate":
      return { rc: 0, stdout: `inject_id: ${randomUUID()}\n${CONSUMED_LINE}\n`, stderr: "" };
    case "queued":
      return { rc: 0, stdout: `inject_id: ${randomUUID()}\n${QUEUED_LINE}\n`, stderr: "" };
    case "refuse":
      return { rc: 1, stdout: "", stderr: `${DEFINITE_REFUSAL_LINE}\n` };
    default:
      return subprocess ? { rc: 1, stdout: "", stderr: "Error: socket hang up\n" } : { rc: null, stdout: "", stderr: "" };
  }
}

/** The answer the spool script prints (or, for `hang`, the file whose creation lets it exit without output). */
export function spoolAnswer(mode: DeliveryMode, releaseFile: string): SpoolAnswer {
  if (mode === "hang") return { hang: releaseFile };
  const a = answerFor(mode, true);
  return { rc: a.rc ?? 1, stdout: a.stdout, stderr: a.stderr };
}

/**
 * The TELEPTY binary for the dispatch subprocess (CommonJS body; the dispatch fixture adds the
 * shebang). Env: SIM_SPOOL = the JSON-lines file it appends `{argv, sessionEnv}` to; SIM_ANSWER = a
 * SpoolAnswer. It never delivers anything itself.
 */
export const SPOOL_SCRIPT = `
const fs = require('node:fs');
fs.appendFileSync(process.env.SIM_SPOOL, JSON.stringify({ argv: process.argv.slice(2),
  sessionEnv: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('TELEPTY_SESSION_')) }) + '\\n');
const a = JSON.parse(process.env.SIM_ANSWER);
if (a.hang) {
  const end = Date.now() + 30000;
  const t = setInterval(() => { if (fs.existsSync(a.hang) || Date.now() > end) { clearInterval(t); process.exitCode = 1; } }, 20);
} else {
  if (a.stdout) process.stdout.write(a.stdout);
  if (a.stderr) process.stderr.write(a.stderr);
  process.exitCode = a.rc;
}
`;

export class FakeTelepty {
  readonly sent: SendRecord[] = [];
  /** Copies the test injected itself (tampered or replayed bytes), never sent by a controller. */
  readonly foreign: string[] = [];
  /** Anything a controller-link module did that the fake did not expect (asserted empty by the test). */
  readonly violations: string[] = [];
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly rules: Array<Rule & { left: number }> = [];
  private delayed: Delayed[] = [];
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  addEndpoint(label: string, host: string, sid: string): Endpoint {
    const ep: Endpoint = { label, host, sid, prompts: [], audit: [], notices: [], downUntil: 0, busyUntil: 0 };
    this.endpoints.set(label, ep);
    return ep;
  }

  endpoint(label: string): Endpoint {
    const ep = this.endpoints.get(label);
    if (ep === undefined) throw new Error(`fake telepty: no endpoint ${label}`);
    return ep;
  }

  /** Planned behaviour for the next matching send(s); rules are matched in the order planned. */
  plan(rule: Rule): void {
    this.rules.push({ ...rule, left: rule.count ?? 1 });
  }

  /** Receiving daemon down → refuse; else the first matching rule; a busy receiver turns `deliver` into `queued`. */
  chooseMode(from: string, to: Endpoint | null, kind: string, ref: string | null): Choice {
    const now = this.now();
    if (to !== null && now < to.downUntil) return { mode: "refuse", delayMs: 0 };
    const r = this.rules.find((x) => x.left > 0 && (x.from === undefined || x.from === from) &&
      (x.kind === undefined || x.kind === kind) && (x.ref === undefined || x.ref === ref));
    let choice: Choice = { mode: "deliver", delayMs: 0 };
    if (r !== undefined) {
      r.left -= 1;
      choice = { mode: r.mode, delayMs: r.delayMs ?? 0 };
    }
    if (choice.mode === "deliver" && to !== null && now < to.busyUntil) choice = { mode: "queued", delayMs: 0 };
    return choice;
  }

  private byTarget(target: string): Endpoint | null {
    const at = target.lastIndexOf("@");
    if (at < 0) return null;
    const sid = target.slice(0, at);
    const host = target.slice(at + 1);
    for (const ep of this.endpoints.values()) if (ep.host === host && ep.sid === sid) return ep;
    return null;
  }

  private row(to: Endpoint, text: string, queued: boolean): AuditRow {
    return {
      inject_id: randomUUID(), to: to.sid, claimed_from: "controller-link", payload_sha256: sha256(text),
      claimed_cross_host: true, delivery_result: queued ? "queued" : "success", at: new Date(this.now()).toISOString(),
    };
  }

  /** The receiving daemon logs the inject and shows it to the session, after its provenance banner. */
  private land(to: Endpoint, from: string, text: string, queued: boolean): void {
    to.audit.push(this.row(to, text, queued));
    const fromHost = this.endpoints.get(from)?.host ?? "unknown";
    to.prompts.push(`[telepty] inject from controller-link @ ${fromHost}\n${text}`);
  }

  /** One send from `from` to `target`: logged, then delivered (or not) as `preset` or the plan says. */
  transmit(from: string, target: string, text: string, via: "cli" | "dispatch", preset: Choice | null): Answer {
    const to = this.byTarget(target);
    const parsed = parseEnvelope(text);
    if (!parsed.ok || parsed.envelope.text !== text) this.violations.push(`${from} sent text that is not a canonical envelope (${via})`);
    const f = parsed.ok ? parsed.envelope.fields : null;
    const kind = f?.kind ?? "?";
    const choice = preset ?? this.chooseMode(from, to, kind, f?.ref ?? null);
    this.sent.push({
      n: this.sent.length + 1, from, to: to?.label ?? null, via, mode: choice.mode, at: this.now(), kind,
      id: f?.id ?? "?", seq: f?.seq ?? 0, ref: f?.ref ?? null, state: f?.state ?? null, sha256: sha256(text), text,
    });
    if (to === null) {
      this.violations.push(`${from} sent to an unknown target ${target}`);
      return { rc: 1, stdout: "", stderr: "No peer registered with machine id or address\n" };
    }
    switch (choice.mode) {
      case "deliver":
        this.land(to, from, text, false);
        break;
      case "queued":
        this.land(to, from, text, true);
        break;
      case "duplicate":
        this.land(to, from, text, false);
        this.land(to, from, text, false);
        break;
      case "drop":
        to.audit.push(this.row(to, text, false));
        break;
      case "delay":
      case "uncertain_delayed":
        this.delayed.push({ to, from, text, releaseAt: this.now() + choice.delayMs });
        break;
      default:
        break; // refuse, lost, hang: nothing arrives
    }
    return answerFor(choice.mode, via === "dispatch");
  }

  /** U3 ProcessRunner for controller `from` (in-process CLI and pump). */
  runner(from: string): ProcessRunner {
    return {
      run: async (_bin, argv, opts) => {
        const leaked = Object.keys(opts.env).filter((k) => k.toUpperCase().startsWith("TELEPTY_SESSION_"));
        if (leaked.length > 0) this.violations.push(`${from}: TELEPTY_SESSION_* reached telepty: ${leaked.join(",")}`);
        if (argv.length !== 9 || C7_PREFIX.some((a, i) => argv[i] !== a)) {
          this.violations.push(`${from}: unexpected telepty argv ${JSON.stringify(argv.slice(0, 8))}`);
          return { rc: 99, stdout: "", stderr: "fake telepty: unexpected argv\n", truncated: false };
        }
        return { ...this.transmit(from, argv[7]!, argv[8]!, "cli", null), truncated: false };
      },
    };
  }

  /** Carries what the dispatch subprocess's fake telepty recorded; returns how many sends it found. */
  drainSpool(from: string, spoolFile: string, choice: Choice): number {
    const lines = fs.existsSync(spoolFile) ? fs.readFileSync(spoolFile, "utf8").split("\n").filter((l) => l !== "") : [];
    for (const line of lines) {
      const e = JSON.parse(line) as { argv: string[]; sessionEnv: string[] };
      if (e.sessionEnv.length > 0) this.violations.push(`${from}: TELEPTY_SESSION_* reached telepty from dispatch`);
      if (e.argv.length !== 9 || C7_PREFIX.some((a, i) => e.argv[i] !== a)) {
        this.violations.push(`${from}: unexpected dispatch telepty argv ${JSON.stringify(e.argv.slice(0, 8))}`);
        continue;
      }
      this.transmit(from, e.argv[7]!, e.argv[8]!, "dispatch", choice);
    }
    return lines.length;
  }

  /** U6 AuditReader over this machine's fake `telepty injects --json --to <sid> --from controller-link --since <iso> --limit <n>` (one query, no paging). */
  auditReader(label: string): AuditReader {
    const ep = this.endpoint(label);
    return {
      page: async (q) => {
        const since = Date.parse(q.since);
        return {
          rows: ep.audit.filter((r) => r.to === q.to && r.claimed_from === q.from && Date.parse(String(r.at)) >= since),
        };
      },
    };
  }

  /** The pump's local-notice sender (report pump TeleptyPort.inject): to this controller only, shown as a prompt. */
  noticePort(label: string): { inject(dest: string, text: string): InjectResult } {
    const ep = this.endpoint(label);
    return {
      inject: (dest, text) => {
        if (dest !== ep.sid) {
          this.violations.push(`${label}: a local notice went to ${dest}`);
          return { rc: 1, stdout: "", stderr: "❌ [SESSION_NOT_FOUND] no such session\n" };
        }
        ep.notices.push({ at: this.now(), text });
        ep.prompts.push(text);
        return { rc: 0, stdout: `inject_id: ${randomUUID()}\n${CONSUMED_LINE}\n`, stderr: "" };
      },
    };
  }

  /** A copy no controller sent (tampered or forged bytes); `audited` = this machine's daemon logged it cross-host. */
  injectForeign(toLabel: string, text: string, audited: boolean): void {
    const to = this.endpoint(toLabel);
    this.foreign.push(text);
    if (audited) to.audit.push(this.row(to, text, false));
    to.prompts.push(`[telepty] inject from controller-link @ unknown\n${text}`);
  }

  /** Delivers every delayed text that is due; returns how many. */
  releaseDue(): number {
    const now = this.now();
    const due = this.delayed.filter((d) => d.releaseAt <= now);
    this.delayed = this.delayed.filter((d) => d.releaseAt > now);
    for (const d of due) this.land(d.to, d.from, d.text, false);
    return due.length;
  }

  /** The earliest pending release, or null. */
  nextRelease(): number | null {
    return this.delayed.length === 0 ? null : Math.min(...this.delayed.map((d) => d.releaseAt));
  }
}
