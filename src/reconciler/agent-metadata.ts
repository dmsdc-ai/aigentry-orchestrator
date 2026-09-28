// #1162 G3 — the status half of the agent-metadata record, built from what the
// reconciler tick has ALREADY read. Pure: no fs, no subprocess, no clock. cli.ts
// owns every read and the adapter call (wh-cli.sh agent-meta-set); the adapter owns
// the sealed binding and cli/model/effort. Nothing here may promote a weak signal:
// CONNECTED is a connection, never an activity; a dispatch lifecycle is a label,
// never completion; anything unproven is "unknown".

export type Connection = "connected" | "disconnected" | "unknown";

/** Exact key set of `--status-json` (interface lock, adapter CLI contract). */
export interface AgentStatus {
  connection: Connection;
  activity: string;
  activity_source: "probe:current-viewport" | "unknown";
  dispatch: string;
  read_at: number;
}

/** sid syntax v1 (worker-sandbox.ts identity). */
export const SID_V1 = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** session-probe.py `surface` values accepted as activity (CONTRACT-r2 §4). */
const ACTIVITIES: ReadonlySet<string> = new Set([
  "working", "idle", "welcome", "unsubmitted", "modal", "sandbox_prompt", "error", "crash", "sleep_cut",
  "raw_shell", "thinking_block", "unknown",
]);

const DISPATCH_STATE = /^[a-z_]{1,40}$/;

/** Verbatim telepty healthStatus; anything else is unknown (no stale, no lastSeenAt fallback). */
export function connectionOf(healthStatus: unknown): Connection {
  if (healthStatus === "CONNECTED") return "connected";
  if (healthStatus === "DISCONNECTED") return "disconnected";
  return "unknown";
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Activity from ONE session-probe.py JSON already measured this tick. Taken only
 * when the probe reports no probe_error AND its screen came from a current
 * viewport; otherwise unknown. `undefined` (no probe for this sid) is unknown.
 */
export function activityOf(probeJson: string | undefined): Pick<AgentStatus, "activity" | "activity_source"> {
  const unknown = { activity: "unknown", activity_source: "unknown" } as const;
  if (probeJson === undefined) return unknown;
  let state: unknown;
  try {
    state = JSON.parse(probeJson);
  } catch {
    return unknown;
  }
  if (!record(state) || !record(state.detail)) return unknown;
  const detail = state.detail;
  if (detail.probe_error !== undefined) return unknown;
  const source = detail.screen_source;
  if (typeof source !== "string" || !source.endsWith(":current-viewport")) return unknown;
  const surface = state.surface;
  if (typeof surface !== "string" || !ACTIVITIES.has(surface)) return unknown;
  return { activity: surface, activity_source: "probe:current-viewport" };
}

/** The sid's lifecycle.state values from one `list --live` snapshot: 0 → none, >1 → multiple. */
export function dispatchOf(states: readonly string[] | undefined): string {
  if (!states || states.length === 0) return "none";
  if (states.length > 1) return "multiple";
  const s = states[0]!;
  return DISPATCH_STATE.test(s) ? s : "unknown";
}

/**
 * Exit-code class of an adapter verb (interface lock: 0/10/20/30). Only 0 is
 * success, and only an explicit 20 is "unsupported" — the one class that may take
 * the bounded legacy connection pill. 10, 30, any other code, a signal or a spawn
 * failure is never widened into either.
 */
export type MetaOutcome = "applied" | "refused" | "unsupported" | "failed";

export function metaOutcome(rc: number): MetaOutcome {
  if (rc === 0) return "applied";
  if (rc === 10) return "refused";
  if (rc === 20) return "unsupported";
  return "failed";
}

export function agentStatus(
  healthStatus: unknown,
  probeJson: string | undefined,
  dispatchStates: readonly string[] | undefined,
  readAt: number,
): AgentStatus {
  return {
    connection: connectionOf(healthStatus),
    ...activityOf(probeJson),
    dispatch: dispatchOf(dispatchStates),
    read_at: readAt,
  };
}
