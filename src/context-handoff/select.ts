// #1201 — selection by last activity across every adapter (SPEC §3.3, owner criterion 3).
// Not the CLI being booted, and not the prior boot record: the newest `lastActivity` among
// cwd-verified candidates wins; ties break by cli name, then sessionId, ascending.
import { ADAPTERS, DETECT_ONLY } from "./adapters/index.js";
import type { Detection, Env, Limits, TranscriptAdapter, TranscriptRef } from "./types.js";

export interface Selection {
  readonly chosen: TranscriptRef | null;
  readonly adapter: TranscriptAdapter | null;
  readonly warning: string | null;
  readonly detections: readonly Detection[];
  readonly timedOut: boolean;
}

export interface Exclusion {
  /** Exclude candidates whose FIRST record is at or after this instant (§3.3.4). */
  readonly before?: number;
  /** Exclude this session id (the in-session backstop's own Claude session). */
  readonly sessionId?: string;
}

function cmp(a: TranscriptRef, b: TranscriptRef): number {
  const d = Date.parse(b.lastActivity) - Date.parse(a.lastActivity);
  if (d !== 0) return d;
  if (a.cli !== b.cli) return a.cli < b.cli ? -1 : 1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

function excluded(ref: TranscriptRef, ex: Exclusion): boolean {
  if (ex.sessionId !== undefined && ref.sessionId === ex.sessionId) return true;
  if (ex.before === undefined) return false;
  // A candidate whose start is unknown is judged by its last activity instead.
  const start = Date.parse(ref.firstActivity ?? ref.lastActivity);
  return Number.isFinite(start) && start >= ex.before;
}

export function selectSource(
  env: Env,
  workspace: string,
  limits: Limits,
  ex: Exclusion = {},
  adapters: readonly TranscriptAdapter[] = ADAPTERS,
): Selection {
  const pool: { ref: TranscriptRef; adapter: TranscriptAdapter }[] = [];
  let timedOut = false;
  for (const adapter of adapters) {
    if (adapter.status !== "measured") continue;
    for (const root of adapter.roots(env)) {
      if (Date.now() > limits.deadlineAt) {
        timedOut = true;
        break;
      }
      try {
        for (const ref of adapter.list(root, workspace, limits)) {
          if (!excluded(ref, ex)) pool.push({ ref, adapter });
        }
      } catch {
        // An adapter that fails contributes no candidate; it never stops the others.
      }
    }
  }
  pool.sort((a, b) => cmp(a.ref, b.ref));
  const top = pool[0] ?? null;
  const detections: Detection[] = [];
  for (const store of DETECT_ONLY) {
    try {
      const d = store.detect(env, limits);
      if (d !== null) detections.push(d);
    } catch {
      // Detect-only data is advisory.
    }
  }
  let warning: string | null = null;
  if (top !== null) {
    const newer = detections.filter((d) => d.mtimeMs > Date.parse(top.ref.lastActivity)).map((d) => d.store);
    if (newer.length > 0) warning = `newer activity in unmeasured ${newer.join("/")} store — handoff may not be the latest`;
  }
  return { chosen: top?.ref ?? null, adapter: top?.adapter ?? null, warning, detections, timedOut };
}
