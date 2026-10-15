// #1201 — the engine's two entries (SPEC §3, §8, §10).
//
// `resolveHandoff(o)` — the frozen W↔B interface. Scans every adapter's store read-only, picks
// the newest cwd-verified session across all CLIs, extracts, redacts, composes, and (with
// `write:true`) writes `<ws>/state/handoff/latest.{md,json}`. Synchronous, never throws, writes
// NOTHING to fd 1; the caller prints `stderrLine`. Any failure is a `skipped:*` outcome with
// `ref:null`, which the boot treats as "argv unchanged".
//
// `runHandoff(argv)` — the script entry (`bin/context-handoff.mjs`): prints the composed handoff
// (or `--json` the record) to stdout. Exit 0 when a handoff was printed, 3 when there is none,
// 2 on invalid invocation or output failure.
//
// No shutdown hook, no per-tick writer: the only inputs are the native transcripts and
// byproducts that already exist (owner criterion 1).
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compose } from "./compose.js";
import { readCapture, readDispatches, readGit, readSnapshotMtime, readTasks, type Enrichment } from "./enrich.js";
import { selectSource } from "./select.js";
import { checkStateDir, handoffDir, writeHandoff } from "./write.js";
import {
  READ_FLAGS, regularFile,
  type Extract, type Handoff, type HandoffDelivery, type HandoffOutcome, type HandoffRecord, type Limits,
  type TranscriptRef,
} from "./types.js";

export type { Handoff, HandoffDelivery, HandoffOutcome, HandoffRecord, TranscriptRef } from "./types.js";

const K = 20;
const TAIL_BYTES = 8 * 1024 * 1024;
const PROBE_BYTES = 1024 * 1024;
const HASH_MAX = 64 * 1024 * 1024;
const LINE_MAX_BYTES = 400;
const SETTLE_STABLE_MS = 300;
const SETTLE_MAX_MS = 1500;
const SETTLE_POLL_MS = 50;
const GIT_RESERVE_MS = 2200;
const SCRIPT_DEADLINE_MS = 10_000;

export interface ResolveOptions {
  readonly workspace: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly bootId: string;
  readonly write: boolean;
  /** An absolute epoch-ms deadline when > 1e12, else a budget in ms from the call. */
  readonly deadlineMs: number;
  /**
   * Optional, additive to the frozen §10 shape: the booted CLI's delivery as the caller derives
   * it from provider-capabilities.ts. Absent → `record.delivery` is null and the line says
   * `delivery=unset`. The engine never decides delivery itself (F6: one source of argv truth).
   */
  readonly delivery?: HandoffDelivery;
}

interface ScriptExtras {
  readonly before?: number;
  readonly excludeSessionId?: string;
  readonly capture?: Enrichment["capture"];
  readonly producer?: string;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/** Wait until the transcript's size has been stable for 300 ms, at most 1.5 s (SPEC §6.1). */
function settle(file: string, deadlineAt: number): void {
  const stop = Math.min(Date.now() + SETTLE_MAX_MS, deadlineAt);
  let size = regularFile(file)?.size ?? -1;
  let stableSince = Date.now();
  while (Date.now() < stop && Date.now() - stableSince < SETTLE_STABLE_MS) {
    sleep(Math.min(SETTLE_POLL_MS, stop - Date.now()));
    const now = regularFile(file)?.size ?? -1;
    if (now !== size) {
      size = now;
      stableSince = Date.now();
    }
  }
}

/** sha256 of the whole transcript when ≤ 64 MiB (read-only), else `skipped:oversize`. */
function transcriptSha(file: string): string {
  const st = regularFile(file);
  if (st === null || st.size > HASH_MAX) return "skipped:oversize";
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, READ_FLAGS);
    const h = createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > HASH_MAX) return "skipped:oversize";
      h.update(buf.subarray(0, n));
    }
    return h.digest("hex");
  } catch {
    return "skipped:oversize";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

function deliveryText(d: HandoffDelivery | undefined): string {
  if (d === undefined) return "unset";
  return `${d.cli}:${d.content}${d.first_turn === "measured" ? "+first-turn" : ""}`;
}

/** The single-line, file-pointing first turn (SPEC §6.2); null when it breaks the argv rules. */
export function firstTurnLine(ref: TranscriptRef, file: string): string | null {
  const line = `aigentry handoff: continuing from ${ref.cli} session ${ref.sessionId.slice(0, 8)}, last activity ${ref.lastActivity}. ` +
    `Load ${file} in full before anything else, then reply with one line naming what you are continuing and wait for the user.`;
  // eslint-disable-next-line no-control-regex
  if (Buffer.byteLength(line, "utf8") > LINE_MAX_BYTES || /[\u0000-\u001F\u007F-\u009F]/.test(line) || line.startsWith("-")) return null;
  return line;
}

function computeHandoff(o: ResolveOptions, extra: ScriptExtras): Handoff {
  const started = Date.now();
  const deadlineAt = o.deadlineMs > 1e12 ? o.deadlineMs : started + Math.max(0, o.deadlineMs);
  const producer = extra.producer ?? "orchestrator-boot";
  const derivedAt = o.now.toISOString();
  let source: TranscriptRef | null = null;
  let warning: string | null = null;

  const finish = (
    outcome: HandoffOutcome,
    markdown: string | null = null,
    ref: Handoff["ref"] = null,
    sha = "skipped:oversize",
  ): Handoff => {
    const mdBytes = markdown === null ? 0 : Buffer.byteLength(markdown, "utf8");
    const record: HandoffRecord = {
      v: 1,
      boot_id: o.bootId,
      written_at: derivedAt,
      outcome,
      source: source === null ? null : {
        cli: source.cli, session_id: source.sessionId, path: source.path, bytes: source.bytes,
        last_activity: source.lastActivity, sha256: sha,
      },
      handoff: markdown === null ? null : {
        sha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
        bytes: mdBytes,
        lines: markdown.split("\n").length - 1,
      },
      delivery: o.delivery ?? null,
      warning,
    };
    let stderrLine = `[${producer}] handoff: ${outcome}`;
    if (source !== null) {
      stderrLine += ` source=${source.cli}:${source.sessionId.slice(0, 8)} last=${source.lastActivity} bytes=${mdBytes} delivery=${deliveryText(o.delivery)}`;
    }
    if (warning !== null) stderrLine += ` warning=${warning}`;
    return { ref, record, stderrLine: stderrLine.replace(/[\r\n]/g, " "), markdown };
  };

  try {
    const mode = o.env.AIGENTRY_HANDOFF;
    if (mode !== undefined && mode !== "" && mode !== "auto") return finish("skipped:off");
    const workspace = fs.realpathSync.native(path.resolve(o.workspace));
    if (o.write) {
      const state = checkStateDir(workspace);
      if (state !== null) return finish(state);
    }
    const limits: Limits = { k: K, tailBytes: TAIL_BYTES, probeBytes: PROBE_BYTES, deadlineAt };
    const sel = selectSource(o.env, workspace, limits, {
      ...(extra.before !== undefined ? { before: extra.before } : {}),
      ...(extra.excludeSessionId !== undefined ? { sessionId: extra.excludeSessionId } : {}),
    });
    if (sel.timedOut || Date.now() > deadlineAt) return finish("skipped:timeout");
    if (sel.chosen === null || sel.adapter === null) return finish("skipped:no-source");
    source = sel.chosen;
    warning = sel.warning;

    if (o.write) {
      settle(source.path, deadlineAt);
      const st = regularFile(source.path);
      if (st !== null) source = { ...source, bytes: st.size, mtimeMs: st.mtimeMs };
    }
    const extract: Extract = sel.adapter.extract(source, limits);
    if (Date.now() > deadlineAt) return finish("skipped:timeout");
    const sha = transcriptSha(source.path);

    const enrichment: Enrichment = {
      tasks: readTasks(workspace, o.env),
      dispatches: readDispatches(workspace),
      capture: extra.capture ?? null,
      snapshotMtime: readSnapshotMtime(workspace),
      git: deadlineAt - Date.now() > GIT_RESERVE_MS ? readGit(workspace, o.env) : null,
    };
    const markdown = compose({
      ref: source,
      extract,
      warning,
      enrichment,
      derivedAt,
      producer,
      bootId: o.bootId,
      transcriptSha: sha,
      taskQueue: o.env.AIGENTRY_TASK_QUEUE || "state/task-queue.json",
    });
    const file = path.join(handoffDir(workspace), "latest.md");
    const line = firstTurnLine(source, file);
    if (line === null) return finish("skipped:invalid-line", markdown, null, sha);
    if (Date.now() > deadlineAt) return finish("skipped:timeout", markdown, null, sha);
    const ref = { file, line, source };
    if (!o.write) return finish("composed", markdown, ref, sha);

    const planned = finish("written", markdown, ref, sha);
    const outcome = writeHandoff(
      workspace,
      Buffer.from(markdown, "utf8"),
      Buffer.from(`${JSON.stringify(planned.record)}\n`, "utf8"),
    );
    return outcome === "written" ? planned : finish(outcome, markdown, null, sha);
  } catch {
    return finish("skipped:error");
  }
}

/** The frozen W↔B interface (SPEC §10). */
export function resolveHandoff(o: ResolveOptions): Handoff {
  return computeHandoff(o, {});
}

// ── script entry ────────────────────────────────────────────────────────────
interface ScriptArgs {
  workspace: string | null;
  before: number | null;
  json: boolean;
  write: boolean;
}

function parseArgs(args: readonly string[]): ScriptArgs | null {
  const out: ScriptArgs = { workspace: null, before: null, json: false, write: false };
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--json" && !out.json) out.json = true;
    else if (flag === "--write" && !out.write && !dryRun) out.write = true;
    else if (flag === "--dry-run" && !dryRun && !out.write) dryRun = true;
    else if (flag === "--workspace" && out.workspace === null) {
      const v = args[++i];
      if (typeof v !== "string" || !path.isAbsolute(v)) return null;
      out.workspace = v;
    } else if (flag === "--before" && out.before === null) {
      const v = args[++i];
      const t = typeof v === "string" ? Date.parse(v) : NaN;
      if (!Number.isFinite(t)) return null;
      out.before = t;
    } else {
      return null;
    }
  }
  return out;
}

async function writeStream(stream: NodeJS.WriteStream, text: string): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      stream.write(text, (error) => resolve(!error));
    });
  } catch {
    return false;
  }
}

/**
 * `node bin/context-handoff.mjs [--workspace <abs>] [--before <ISO>] [--json] [--write|--dry-run]`.
 * Without `--before`, candidates that started at or after `state/handoff/latest.json`'s mtime
 * (written by this boot) are excluded, and so is the running Claude session
 * (`CLAUDE_CODE_SESSION_ID`). Nothing is written without `--write`.
 */
export async function runHandoff(argv: readonly string[]): Promise<number> {
  process.stdout.on("error", () => { process.exitCode = 2; });
  const args = parseArgs(argv);
  if (args === null) {
    await writeStream(process.stderr, "context-handoff: invalid invocation — flags: [--workspace <abs>] [--before <ISO>] [--json] [--write|--dry-run]\n");
    return 2;
  }
  const env = process.env;
  const workspace = args.workspace ?? process.cwd();
  let before = args.before;
  if (before === null) {
    let ws = workspace;
    try {
      ws = fs.realpathSync.native(workspace);
    } catch {
      // resolveHandoff reports the unusable workspace.
    }
    const prior = regularFile(path.join(handoffDir(ws), "latest.json"));
    if (prior !== null) before = prior.mtimeMs;
  }
  const self = env.CLAUDE_CODE_SESSION_ID;
  const capture = await readCapture(workspace).catch(() => null);
  const result = computeHandoff(
    { workspace, env, now: new Date(), bootId: randomUUID(), write: args.write, deadlineMs: SCRIPT_DEADLINE_MS },
    {
      ...(before !== null ? { before } : {}),
      ...(self ? { excludeSessionId: self } : {}),
      capture,
      producer: "context-handoff",
    },
  );
  await writeStream(process.stderr, `${result.stderrLine}\n`);
  const printed = result.markdown !== null && (result.record.outcome === "composed" || result.record.outcome === "written");
  const body = args.json ? `${JSON.stringify(result.record)}\n` : printed ? result.markdown as string : "";
  if (body !== "" && !(await writeStream(process.stdout, body))) return 2;
  return printed ? 0 : 3;
}
