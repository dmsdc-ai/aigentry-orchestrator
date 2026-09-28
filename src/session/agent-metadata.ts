// agent-metadata.ts — #1162 G2c: the cmux transport behind
// `wh-cli.sh agent-meta-{caps,set,clear}` (bin/lib/workspace-host.sh forwards here).
//
// Why Node and not bash: every value crossing this seam is structured — the host's
// JSON reply, the sealed binding, the caller's status JSON — and the adapter must
// never eval, concatenate or jq it. This file parses, validates and routes; the
// bash side only resolves this entrypoint (lib/node-shim.sh) and forwards argv 1:1.
//
// Exit contract (controller interface lock, #1162):
//   0  applied / cleared / absent (caps: supported)
//   10 ownership/lifecycle refusal — surface_gone, stale_lifecycle,
//      owned_by_other_sid, stale_attempt, lifecycle_cleared; and binding-drift when a
//      pinned `clear` (all four --expect-* flags) no longer matches the sealed binding
//   20 unsupported: cmux missing, capability missing (unpatched cmux, NO V1
//      fallback), agent binding missing
//   30 parse/transport/invalid input, invalid_params, any unknown host answer
// 10/20/30 never become 0. Diagnostics are one generated stderr line from a closed
// vocabulary; host output is read to classify it, never reproduced.
//
// Host reply shapes, measured from cmux CLI source (cmux.swift @ b685a275c):
//   * `cmux rpc <method> <json-params>` → sendV2; success prints jsonString(result)
//     on stdout, rc 0 (the `rpc` arm, :6664).
//   * a v2 error is thrown as CLIError("<code>: <message>" | "<code>:\n<message>")
//     (formatV2Error) and main prints `Error: <error>` on stderr and exits
//     CLIError.exitCode ?? 1 (:41524); CLIError.description is its message
//     (CLIError.swift). Only an exact leading `Error: <code>:` is read; anything
//     else is an unknown answer (30), never a success.
//   * `cmux capabilities` prints the system.capabilities result as JSON (:5532):
//     {protocol, version, socket_path, access_mode, capabilities, methods:[String]}
//     (TerminalController v2Capabilities). Support (CONTRACT-r3) = a top-level plain
//     object with protocol === "cmux-socket", version === 2 (socket protocol, a
//     number) and `methods` an all-string array holding both exact method names;
//     other top-level fields are ignored. Any other valid reply is "unsupported"
//     (20); a method_not_found answer to set/clear is also 20.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeLaunch } from "./boot-adapter/launch-config.js";
import { isCliKind, type LaunchConfig, type LaunchValue } from "./boot-adapter/types.js";

const SET_METHOD = "surface.agent_metadata.set";
const CLEAR_METHOD = "surface.agent_metadata.clear";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TASK_RE = /^[\x21-\x7e]{1,128}$/;
const DISPATCH_RE = /^[a-z_]{1,40}$/;
const V2_ERROR_RE = /^Error: ([a-z_]{1,64}):(?: |\n)/;

const CONNECTIONS: ReadonlySet<string> = new Set(["connected", "disconnected", "unknown"]);
const ACTIVITIES: ReadonlySet<string> = new Set([
  "working", "idle", "welcome", "unsubmitted", "modal", "sandbox_prompt",
  "error", "crash", "sleep_cut", "raw_shell", "thinking_block", "unknown",
]);
const ACTIVITY_SOURCES: ReadonlySet<string> = new Set(["probe:current-viewport", "unknown"]);
const REFUSALS: ReadonlySet<string> = new Set([
  "surface_gone", "stale_lifecycle", "owned_by_other_sid", "stale_attempt", "lifecycle_cleared",
]);

const HOST_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 1 << 20;
const BINDING_READER = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-binding.js");

class Failure extends Error {
  constructor(readonly exit: 10 | 20 | 30, readonly reason: string) {
    super(reason);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

function parseJson(text: string, reason: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure(30, reason);
  }
}

// ── host transport ──────────────────────────────────────────────────────────
interface HostReply {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One cmux CLI call. CMUX is the adapter's existing injectable-binary seam. */
function cmux(args: readonly string[]): HostReply {
  const r = spawnSync(process.env.CMUX || "cmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HOST_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Failure(20, "host-missing");
    if (code === "ETIMEDOUT") throw new Failure(30, "host-timeout");
    throw new Failure(30, "transport");
  }
  if (r.status === null) throw new Failure(30, "transport");
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 0 when the running host advertises BOTH V2 methods; throws 20/30 otherwise. */
function requireCapabilities(): void {
  const r = cmux(["capabilities"]);
  if (r.status !== 0) throw new Failure(30, "capabilities-failed");
  const caps = parseJson(r.stdout, "capabilities-unparseable");
  // Only the host's own top-level schema is authority: exact protocol, socket protocol
  // version 2, and a `methods` list of strings only. Names anywhere else in the reply
  // (nested objects, other keys, a top-level array) never count.
  if (
    !isPlainObject(caps) || caps.protocol !== "cmux-socket" || caps.version !== 2 ||
    !Array.isArray(caps.methods) || !caps.methods.every((m) => typeof m === "string") ||
    !caps.methods.includes(SET_METHOD) || !caps.methods.includes(CLEAR_METHOD)
  ) {
    throw new Failure(20, "capability-missing");
  }
}

/** `cmux rpc <method> <params>`; returns the result object or throws 10/20/30. */
function rpc(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const r = cmux(["rpc", method, JSON.stringify(params)]);
  if (r.status === 0) {
    const result = parseJson(r.stdout, "reply-unparseable");
    if (!isPlainObject(result)) throw new Failure(30, "reply-unparseable");
    return result;
  }
  const code = V2_ERROR_RE.exec(r.stderr)?.[1];
  if (code !== undefined && REFUSALS.has(code)) throw new Failure(10, code);
  if (code === "method_not_found") throw new Failure(20, "capability-missing");
  if (code === "invalid_params") throw new Failure(30, "invalid_params");
  throw new Failure(30, "host-error");
}

// ── sealed binding (G2b reader, optional-task form) ─────────────────────────
interface Binding {
  readonly sid: string;
  readonly attempt: string;
  readonly manifest_hash: string;
  readonly surface_id: string;
  readonly terminal_lifecycle_id: string;
}

/** The exact tuple a `clear` caller captured (all four --expect-* flags). */
interface Pin {
  readonly attempt: string;
  readonly manifest_hash: string;
  readonly surface_id: string;
  readonly terminal_lifecycle_id: string;
}

const EXPECT_FLAGS = ["--expect-attempt", "--expect-hash", "--expect-surface", "--expect-lifecycle"] as const;

const BINDING_KEYS = [
  "v", "sid", "task", "attempt", "manifest_hash", "workspace_id", "surface_id", "terminal_lifecycle_id",
] as const;

/**
 * `node agent-binding.js --stage ROOT --sid SID` — task omitted, so the reader takes
 * it from the verified sealed manifest (hash, receipt and attempt checks are the
 * reader's). Its output is still re-validated here: this side trusts shape only.
 * With a pin, the reader compares all four fields after validating the chain
 * (rc 10 → binding-drift), and they are compared again here on the parsed output.
 */
function readBinding(stage: string, sid: string, pin?: Pin): { binding: Binding; launch: LaunchConfig } {
  if (!fs.existsSync(BINDING_READER)) throw new Failure(20, "binding-reader-missing");
  const pinArgs = pin
    ? ["--expect-attempt", pin.attempt, "--expect-hash", pin.manifest_hash,
      "--expect-surface", pin.surface_id, "--expect-lifecycle", pin.terminal_lifecycle_id]
    : [];
  const r = spawnSync(process.execPath, [BINDING_READER, "--stage", stage, "--sid", sid, ...pinArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HOST_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  });
  if (r.error || r.status === null) throw new Failure(30, "binding-reader-failed");
  if (r.status === 20) throw new Failure(20, "binding-missing");
  if (r.status === 10 && pin) throw new Failure(10, "binding-drift");
  if (r.status !== 0) throw new Failure(30, "binding-invalid");
  const out = parseJson(r.stdout, "binding-invalid");
  if (!isPlainObject(out) || !hasExactKeys(out, ["binding", "launch"])) throw new Failure(30, "binding-invalid");
  const b = out.binding;
  if (
    !isPlainObject(b) || !hasExactKeys(b, BINDING_KEYS) || b.v !== 1 || b.sid !== sid ||
    typeof b.task !== "string" || !TASK_RE.test(b.task) ||
    typeof b.manifest_hash !== "string" || !HASH_RE.test(b.manifest_hash) ||
    ![b.attempt, b.workspace_id, b.surface_id, b.terminal_lifecycle_id].every(
      (u) => typeof u === "string" && UUID_RE.test(u),
    )
  ) {
    throw new Failure(30, "binding-invalid");
  }
  const raw = out.launch;
  if (!isPlainObject(raw) || !isCliKind(raw.cli)) throw new Failure(30, "binding-invalid");
  if (
    pin && (b.attempt !== pin.attempt || b.manifest_hash !== pin.manifest_hash ||
      b.surface_id !== pin.surface_id || b.terminal_lifecycle_id !== pin.terminal_lifecycle_id)
  ) {
    throw new Failure(10, "binding-drift");
  }
  return {
    binding: {
      sid,
      attempt: b.attempt as string,
      manifest_hash: b.manifest_hash as string,
      surface_id: b.surface_id as string,
      terminal_lifecycle_id: b.terminal_lifecycle_id as string,
    },
    launch: normalizeLaunch(raw.cli, raw),
  };
}

// ── caller status JSON ──────────────────────────────────────────────────────
interface Status {
  readonly connection: string;
  readonly activity: string;
  readonly activity_source: string;
  readonly dispatch: string;
  readonly read_at: number;
}

function parseStatus(text: string): Status {
  const s = parseJson(text, "status-invalid");
  if (!isPlainObject(s) || !hasExactKeys(s, ["connection", "activity", "activity_source", "dispatch", "read_at"])) {
    throw new Failure(30, "status-invalid");
  }
  const { connection, activity, activity_source, dispatch, read_at } = s;
  if (
    typeof connection !== "string" || !CONNECTIONS.has(connection) ||
    typeof activity !== "string" || !ACTIVITIES.has(activity) ||
    typeof activity_source !== "string" || !ACTIVITY_SOURCES.has(activity_source) ||
    (activity_source === "unknown" && activity !== "unknown") ||
    typeof dispatch !== "string" || !DISPATCH_RE.test(dispatch) ||
    typeof read_at !== "number" || !Number.isSafeInteger(read_at) || read_at < 0
  ) {
    throw new Failure(30, "status-invalid");
  }
  return { connection, activity, activity_source, dispatch, read_at };
}

/** LaunchConfig v2 → host value/source. Only a configured value is shown as known. */
function configured(v: LaunchValue): [string, "configured" | "unknown"] {
  return v.source === "default" || v.source.startsWith("env:") ? [v.value, "configured"] : ["unknown", "unknown"];
}

// ── argv ────────────────────────────────────────────────────────────────────
/** `group`: optional flags that must appear all together or not at all. */
function parseArgs(
  args: readonly string[],
  flags: readonly string[],
  group: readonly string[] = [],
): { sid: string; opts: Map<string, string> } {
  const [sid, ...rest] = args;
  if (sid === undefined || !SID_RE.test(sid)) throw new Failure(30, "bad-args");
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] as string;
    const value = rest[i + 1];
    if ((!flags.includes(flag) && !group.includes(flag)) || opts.has(flag) || value === undefined) {
      throw new Failure(30, "bad-args");
    }
    opts.set(flag, value);
  }
  const grouped = group.filter((f) => opts.has(f)).length;
  if (opts.size !== flags.length + grouped || (grouped !== 0 && grouped !== group.length)) {
    throw new Failure(30, "bad-args");
  }
  const stage = opts.get("--stage") as string;
  if (!path.isAbsolute(stage) || stage.includes("\0") || path.normalize(stage) !== stage || stage.endsWith("/")) {
    throw new Failure(30, "bad-args");
  }
  return { sid, opts };
}

function main(argv: readonly string[]): number {
  const [verb, ...args] = argv;
  try {
    switch (verb) {
      case "caps": {
        if (args.length !== 0) throw new Failure(30, "bad-args");
        requireCapabilities();
        process.stdout.write("agent_meta caps=supported adapter=cmux\n");
        return 0;
      }
      case "set": {
        const { sid, opts } = parseArgs(args, ["--stage", "--status-json"]);
        const status = parseStatus(opts.get("--status-json") as string);
        requireCapabilities();
        const { binding, launch } = readBinding(opts.get("--stage") as string, sid);
        const [model, modelSource] = configured(launch.model);
        const [effort, effortSource] = configured(launch.effort);
        const result = rpc(SET_METHOD, {
          surface_id: binding.surface_id,
          terminal_lifecycle_id: binding.terminal_lifecycle_id,
          sid: binding.sid,
          attempt: binding.attempt,
          fields: {
            cli: launch.cli,
            model,
            model_source: modelSource,
            effort,
            effort_source: effortSource,
            connection: status.connection,
            activity: status.activity,
            activity_source: status.activity_source,
            dispatch: status.dispatch,
            read_at: status.read_at,
          },
        });
        if (result.status !== "applied") throw new Failure(30, "reply-unexpected");
        process.stdout.write("agent_meta set=applied\n");
        return 0;
      }
      case "clear": {
        const { sid, opts } = parseArgs(args, ["--stage"], EXPECT_FLAGS);
        // The optional pin is validated before any cmux call; malformed → 30.
        let pin: Pin | undefined;
        if (opts.has("--expect-attempt")) {
          const attempt = opts.get("--expect-attempt") as string;
          const manifestHash = opts.get("--expect-hash") as string;
          const surface = opts.get("--expect-surface") as string;
          const lifecycle = opts.get("--expect-lifecycle") as string;
          if (![attempt, surface, lifecycle].every((u) => UUID_RE.test(u)) || !HASH_RE.test(manifestHash)) {
            throw new Failure(30, "bad-args");
          }
          pin = { attempt, manifest_hash: manifestHash, surface_id: surface, terminal_lifecycle_id: lifecycle };
        }
        requireCapabilities();
        const { binding } = readBinding(opts.get("--stage") as string, sid, pin);
        const result = rpc(CLEAR_METHOD, {
          surface_id: binding.surface_id,
          terminal_lifecycle_id: binding.terminal_lifecycle_id,
          sid: binding.sid,
          attempt: binding.attempt,
        });
        if (result.status !== "cleared" && result.status !== "absent") throw new Failure(30, "reply-unexpected");
        process.stdout.write(`agent_meta clear=${result.status}\n`);
        return 0;
      }
      default:
        throw new Failure(30, "bad-args");
    }
  } catch (e) {
    const f = e instanceof Failure ? e : new Failure(30, "internal");
    const label = verb === "caps" || verb === "set" || verb === "clear" ? verb : "-";
    process.stderr.write(`agent-meta: ${label} rc=${f.exit} reason=${f.reason}\n`);
    return f.exit;
  }
}

process.exitCode = main(process.argv.slice(2));
