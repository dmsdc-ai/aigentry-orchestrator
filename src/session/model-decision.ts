// #1148 — one shared shape for a resolver-managed worker spawn.
//
// bin/model-resolve.mjs (pure) builds a SpawnDecision; dispatch validates it here,
// hands it to boot-prepare as the compact AIGENTRY_SPAWN_DECISION env value and
// passes its ExecutableBinding to prepareWorkerSandbox, which seals it inside the
// hashed manifest; the runner re-checks the identity before every exec. Every
// reader validates through this module, so a malformed or mismatched decision is
// refused before any boot effect rather than half-applied.
//
// `model: null` / `effort.token: null` mean OMIT the flag. Nothing here fills a
// default. `observed` stays { model: null, observed_by: "none" }: a task ACK, a
// worker screen or the requested flags are not provider evidence of the model.
import * as path from "node:path";

export const DECISION_CLIS = ["claude", "codex"] as const;
export type DecisionCli = (typeof DECISION_CLIS)[number];

export type VersionSource = "npm-package-metadata" | "operator-declared" | "unknown";

export interface ExecutableBinding {
  cli: DecisionCli;
  /** Absolute, basename === cli (the name the sandbox binding guard checks). */
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  version: string | null;
  versionSource: VersionSource;
}

export type EffortChannel = "argv:--effort" | "argv:-c model_reasoning_effort";
export type EffortState = "explicit" | "explicit-unverified" | "model-default" | "policy" | "omitted";

export interface EffortSelection {
  channel: EffortChannel;
  token: string | null;
  state: EffortState;
}

export type RequestSource = "flag" | "env" | "role-config" | "none";

export interface SpawnRequest {
  cli?: string;
  model?: string;
  effort?: string;
  executable?: string;
  source: RequestSource;
}

export interface SpawnObserved {
  model: null;
  observed_by: "none";
}

export interface SpawnDecision {
  v: 1;
  task: string;
  sid: string;
  cli: DecisionCli;
  executable: ExecutableBinding;
  model: string | null;
  effort: EffortSelection;
  requested: SpawnRequest;
  decided_by: string;
  evidence_label: string;
  rationale: string;
  observed: SpawnObserved;
}

export interface DecisionExpectation {
  cli: string;
  sid: string;
  task: string;
}

/** Upper bound on the compact env value; a larger value is refused, never truncated. */
export const MAX_DECISION_BYTES = 16384;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// C0, DEL and C1 controls: never valid in a model/effort token or any recorded text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
const EFFORT_CHANNEL: Record<DecisionCli, EffortChannel> = {
  claude: "argv:--effort",
  codex: "argv:-c model_reasoning_effort",
};
const EFFORT_STATES: readonly EffortState[] = ["explicit", "explicit-unverified", "model-default", "policy", "omitted"];
const REQUEST_SOURCES: readonly RequestSource[] = ["flag", "env", "role-config", "none"];
const VERSION_SOURCES: readonly VersionSource[] = ["npm-package-metadata", "operator-declared", "unknown"];

function fail(field: string): never {
  throw new Error(`SPAWN_DECISION_INVALID: ${field}`);
}

function record(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(field);
  return v as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${field}.${k}`);
}

/** A request/selection token: data, never a command. Metacharacters stay; controls do not. */
export function isToken(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !CONTROL.test(v) && v.trim() === v;
}

function token(v: unknown, field: string): string {
  if (!isToken(v)) fail(field);
  return v;
}

function count(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(field);
  return v;
}

function absolute(v: unknown, field: string): string {
  if (typeof v !== "string" || !path.isAbsolute(v) || v.length > 4096 || CONTROL.test(v)) fail(field);
  return v;
}

export function validateExecutableBinding(v: unknown, cli: DecisionCli, field = "executable"): ExecutableBinding {
  const o = record(v, field);
  onlyKeys(o, ["cli", "path", "realpath", "dev", "ino", "size", "mtimeMs", "version", "versionSource"], field);
  if (o.cli !== cli) fail(`${field}.cli`);
  const p = absolute(o.path, `${field}.path`);
  if (path.basename(p) !== cli) fail(`${field}.path`);
  const versionSource = o.versionSource as VersionSource;
  if (!VERSION_SOURCES.includes(versionSource)) fail(`${field}.versionSource`);
  const version = o.version;
  if (version === null) {
    if (versionSource !== "unknown") fail(`${field}.version`);
  } else if (typeof version !== "string" || !VERSION.test(version) || versionSource === "unknown") {
    fail(`${field}.version`);
  }
  return {
    cli, path: p, realpath: absolute(o.realpath, `${field}.realpath`),
    dev: count(o.dev, `${field}.dev`), ino: count(o.ino, `${field}.ino`),
    size: count(o.size, `${field}.size`), mtimeMs: count(o.mtimeMs, `${field}.mtimeMs`),
    version: version as string | null, versionSource,
  };
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.length > max || !PRINTABLE.test(v)) fail(field);
  return v;
}

/** Full structural validation plus the cli/sid/task binding. Throws SPAWN_DECISION_INVALID. */
export function validateSpawnDecision(value: unknown, expect: DecisionExpectation): SpawnDecision {
  const o = record(value, "decision");
  onlyKeys(o, ["v", "task", "sid", "cli", "executable", "model", "effort", "requested", "decided_by",
    "evidence_label", "rationale", "observed"], "decision");
  if (o.v !== 1) fail("v");
  if (!(DECISION_CLIS as readonly unknown[]).includes(o.cli)) fail("cli");
  const cli = o.cli as DecisionCli;
  if (cli !== expect.cli) fail("cli binding");
  if (typeof o.sid !== "string" || !IDENTITY.test(o.sid) || o.sid !== expect.sid) fail("sid binding");
  if (typeof o.task !== "string" || !/^[\x21-\x7e]{1,128}$/.test(o.task) || o.task !== expect.task) fail("task binding");
  const executable = validateExecutableBinding(o.executable, cli);
  const model = o.model === null ? null : token(o.model, "model");
  const e = record(o.effort, "effort");
  onlyKeys(e, ["channel", "token", "state"], "effort");
  if (e.channel !== EFFORT_CHANNEL[cli]) fail("effort.channel");
  const effortToken = e.token === null ? null : token(e.token, "effort.token");
  const state = e.state as EffortState;
  if (!EFFORT_STATES.includes(state) || (state === "omitted") !== (effortToken === null)) fail("effort.state");
  const r = record(o.requested, "requested");
  onlyKeys(r, ["cli", "model", "effort", "executable", "source"], "requested");
  if (!REQUEST_SOURCES.includes(r.source as RequestSource)) fail("requested.source");
  const requested: SpawnRequest = { source: r.source as RequestSource };
  if (r.cli !== undefined) requested.cli = token(r.cli, "requested.cli");
  if (r.model !== undefined) requested.model = token(r.model, "requested.model");
  if (r.effort !== undefined) requested.effort = token(r.effort, "requested.effort");
  if (r.executable !== undefined) requested.executable = absolute(r.executable, "requested.executable");
  const decidedBy = text(o.decided_by, "decided_by", 40);
  if (!/^(explicit|deterministic|llm|table)(-capped)?$/.test(decidedBy)) fail("decided_by");
  const label = text(o.evidence_label, "evidence_label", 400);
  if (!/^(current-as-of-\d{4}-\d{2}-\d{2}T[0-9:.]+Z|degraded:[\x21-\x7e]+)$/.test(label)) fail("evidence_label");
  const rationale = text(o.rationale, "rationale", 2000);
  const obs = record(o.observed, "observed");
  onlyKeys(obs, ["model", "observed_by"], "observed");
  if (obs.model !== null || obs.observed_by !== "none") fail("observed");
  return {
    v: 1, task: o.task, sid: o.sid, cli, executable, model,
    effort: { channel: EFFORT_CHANNEL[cli], token: effortToken, state }, requested,
    decided_by: decidedBy, evidence_label: label, rationale, observed: { model: null, observed_by: "none" },
  };
}

/** Parse the compact env/stdout form. Oversized, non-JSON or mismatched input throws. */
export function parseSpawnDecision(raw: string, expect: DecisionExpectation): SpawnDecision {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > MAX_DECISION_BYTES) fail("size");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("json"); }
  return validateSpawnDecision(value, expect);
}

/** The model/effort argv a decision carries for its CLI. Empty arrays mean the flag is omitted. */
export function decisionModelArgv(d: SpawnDecision): string[] {
  if (d.model === null) return [];
  return d.cli === "codex" ? ["-m", d.model] : ["--model", d.model];
}

export function decisionEffortArgv(d: SpawnDecision): string[] {
  if (d.effort.token === null) return [];
  return d.cli === "codex" ? ["-c", `model_reasoning_effort=${d.effort.token}`] : ["--effort", d.effort.token];
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** Stat identity equality. A stat check only: it does not eliminate an open/exec TOCTOU window. */
export function sameFileIdentity(binding: FileIdentity, stat: FileIdentity): boolean {
  return binding.dev === stat.dev && binding.ino === stat.ino &&
    binding.size === stat.size && binding.mtimeMs === stat.mtimeMs;
}
