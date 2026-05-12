// ADR-MF #9 — Spawn-validation telemetry (append-only NDJSON event log).
//
// Article 17 무의존: Node stdlib only (fs / path / os) — no `jq`, no deps.
// Article 2 크로스: paths resolve via os.homedir(); UTC dates in suffix so
// macOS / Linux / Windows machines reading the same NDJSON line up.
// Privacy: schema-fixed. emit() rejects any event carrying unknown keys
// (TypeError) so user content cannot leak even if a caller adds it by accident.
//
// ADR-MF #15 (OQ-15-4, 2026-05-12) — additional `reason` string values used by
// the Class C MCP deliberation adapter: `mcp_phase1_logged`, `mcp_phase1_ungated`,
// `mcp_phase2_accepted`, `mcp_phase2_rejected` (suffixed with `:<tool_name>`).
// These reuse the existing `SpawnEventKind` set — no schema-guard impact.
import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ValidationMode = "hard-fail" | "warn" | "off";

export type SpawnEventKind =
  | "spawn_accepted"
  | "spawn_rejected"
  | "spawn_degraded"
  | "mode_changed";

export interface SpawnEvent {
  ts: string; // ISO-8601 UTC
  event: SpawnEventKind;
  mode: ValidationMode;
  session_id: string | null;
  parent_id: string | null;
  reason: string;
  violations: ReadonlyArray<{ code: string; detail: string }>;
  ctx_digest: string | null;
}

export interface EmitOptions {
  root?: string; // override for tests; default = ${homedir}/.aigentry/telemetry
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  "ts",
  "event",
  "mode",
  "session_id",
  "parent_id",
  "reason",
  "violations",
  "ctx_digest",
]);

const VALID_KINDS: ReadonlySet<string> = new Set<string>([
  "spawn_accepted",
  "spawn_rejected",
  "spawn_degraded",
  "mode_changed",
] satisfies SpawnEventKind[]);

const VALID_MODES: ReadonlySet<string> = new Set<string>([
  "hard-fail",
  "warn",
  "off",
] satisfies ValidationMode[]);

// Privacy + schema guard. Loud (TypeError) on first sight of a forbidden key
// so misuse fails during dev rather than silently writing a fat record.
function assertSchema(e: SpawnEvent): void {
  for (const k of Object.keys(e)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new TypeError(`spawn-events: forbidden key '${k}' in event`);
    }
  }
  if (!VALID_KINDS.has(e.event)) {
    throw new TypeError(`spawn-events: unknown event kind '${e.event}'`);
  }
  if (!VALID_MODES.has(e.mode)) {
    throw new TypeError(`spawn-events: unknown mode '${e.mode}'`);
  }
  if (typeof e.ts !== "string" || e.ts === "") {
    throw new TypeError("spawn-events: ts must be a non-empty string");
  }
  if (!Array.isArray(e.violations)) {
    throw new TypeError("spawn-events: violations must be an array");
  }
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function telemetryRoot(opts: EmitOptions = {}): string {
  return opts.root ?? join(homedir(), ".aigentry", "telemetry");
}

export function dailyFilePath(date: Date, opts: EmitOptions = {}): string {
  return join(telemetryRoot(opts), `spawn-events-${utcDateStr(date)}.ndjson`);
}

export function emit(event: SpawnEvent, opts: EmitOptions = {}): void {
  assertSchema(event);
  const root = telemetryRoot(opts);
  mkdirSync(root, { recursive: true });
  const path = dailyFilePath(new Date(event.ts), opts);
  appendFileSync(path, JSON.stringify(event) + "\n", { encoding: "utf8" });
}

export function readEventsForDay(
  date: Date,
  opts: EmitOptions = {},
): SpawnEvent[] {
  const path = dailyFilePath(date, opts);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: SpawnEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as SpawnEvent);
  }
  return out;
}
