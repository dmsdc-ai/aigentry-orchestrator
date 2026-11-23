// controller-link v1 send + classify (SPEC §6.1 steps 2–3).
//
// One call = one telepty inject whose whole text is one canonical envelope (U1 codec), sent to the
// peer controller with a fixed argv and no shell:
//
//   telepty inject --submit --no-submit-force --submit-retry 0 --from controller-link <peer_target> <envelope>
//
// Never `--ref`, never `--submit-force`, never an Enter-only send, never a retry inside this call.
// The outcome is classified from exit code, stdout and stderr only (first match wins):
//
//   handed_over       exit 0 and exactly one `inject_id:` line (HTTP arm), or the SSH-arm success line
//                     `✅ Context injected successfully into '…' @ <peer>` after stripping ANSI escapes.
//                     `submit` = submitOutcome() of the report pump, unchanged (values: API.md).
//   refused_definite  non-zero exit, no `inject_id:` text anywhere, and a line starting `❌ [<CODE>]` with
//                     CODE in the SPEC list, or one of the two resolver refusals. Nothing was delivered; the caller
//                     may later re-send the SAME bytes.
//   unknown           everything else (timeout kill, `inject_id:` with a non-zero exit, unknown text).
//                     Never re-sent without a probe (SPEC §9.2).
//
// The markers are telepty's human-facing output (SPEC §6.1, quoting T/cli.js and T/src/...; the
// telepty source is not in this repository). A wording change falls through to `unknown`, the safe
// side (THREAT-MODEL R6). No store access here: the caller records the attempt (§6.1 steps 1 and 4).
import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

import { parseInjectId } from "../dispatch/inject-id.js";
import type { SubmitOutcome } from "../report/decide.js";
import { submitOutcome, teleptyChildEnv, type InjectResult } from "../report/pump.js";
import { parseEnvelope } from "./envelope.js";

/** The fixed `--from` of every controller-link inject (SPEC §6.1 step 2). */
export const SEND_FROM = "controller-link";
/** SPEC §6.1 step 2: 120 s, then the child is killed and the result is `unknown`. */
export const SEND_TIMEOUT_MS = 120_000;
/** Captured bytes per stream; more is dropped and the result is forced to `unknown`. */
export const SEND_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** After a timeout kill, how long to wait for the child's streams to close before giving up on them. */
export const KILL_GRACE_MS = 5_000;

export const SEND_RESULTS = ["handed_over", "refused_definite", "unknown"] as const;
export type SendResult = (typeof SEND_RESULTS)[number];

/**
 * `❌ [<CODE>]` codes that telepty answers before any byte is written (SPEC §6.1 step 3, citing
 * T/src/routes/session-actions.js:1548, :1559, :1615, :1638-1654, :1712 and
 * T/src/mailbox/session-delivery.js:63).
 */
export const DEFINITE_REFUSAL_CODES = [
  "TRACKING_PERSISTENCE_FAILED", "TRACKING_CAPACITY", "SESSION_NOT_FOUND", "PEER_INJECT_BLOCKED",
  "QUEUE_TIMEOUT", "INVALID_REQUEST", "POLL_ONLY",
] as const;

/** Resolver refusals printed before any network write (SPEC §6.1 step 3, citing T/cli.js:4239, :1366-1370). */
export const RESOLVER_REFUSALS = [
  "was not found on any discovered host",
  "No peer registered with machine id or address",
] as const;

/** The SSH arm's success line (SPEC §6.1 step 3, citing T/cli.js:4277), matched after ANSI stripping. */
export const SSH_SUCCESS_RE = /^[ \t]*✅ Context injected successfully into '[^'\n]+' @ [^\s]+[ \t]*$/;

/** SPEC §2: `<controller_sid>@<telepty peer name>`; the sid uses the sandbox identity rule. */
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** ANSI CSI sequences (colour, cursor) and OSC sequences. */
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const INJECT_ID_LINE_RE = /^[ \t]*inject_id:/;

export interface SendClassification {
  result: SendResult;
  /** handed_over only: submitOutcome() of the run; null otherwise. */
  submit: SubmitOutcome | null;
  /** handed_over through the HTTP arm only: the one id telepty printed; null otherwise. */
  inject_id: string | null;
  /** refused_definite: the matched code or resolver text; unknown: why; handed_over: null. */
  detail: string | null;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * SPEC §6.1 step 3. Pure: no clock, no file, no process. `rc` null = killed (timeout) or no exit
 * status at all, which is always `unknown`.
 */
export function classifySend(r: InjectResult): SendClassification {
  const out = stripAnsi(r.stdout).replace(/\r/g, "");
  const all = stripAnsi(`${r.stdout}\n${r.stderr}`).replace(/\r/g, "");
  const unknown = (detail: string): SendClassification => ({ result: "unknown", submit: null, inject_id: null, detail });
  if (r.rc === null) return unknown("killed_or_no_exit_status");
  if (r.rc === 0) {
    const idLines = all.split("\n").filter((l) => INJECT_ID_LINE_RE.test(l)).length;
    const id = parseInjectId(r.stdout);
    if (idLines === 1 && id !== "") return { result: "handed_over", submit: submitOutcome(r), inject_id: id, detail: null };
    if (out.split("\n").some((l) => SSH_SUCCESS_RE.test(l))) {
      return { result: "handed_over", submit: submitOutcome(r), inject_id: null, detail: null };
    }
    return unknown(idLines > 1 ? "exit_0_inject_id_not_unique" : "exit_0_without_handover_marker");
  }
  // Non-zero exit. Any `inject_id:` text means the peer may hold the bytes (the composer without Enter).
  if (all.includes("inject_id:")) return unknown("inject_id_with_nonzero_exit");
  // Output that quotes an envelope could carry a refusal string from the body, not from telepty.
  if (all.includes("⟦aigentry-ctl")) return unknown("output_echoes_envelope");
  const lines = all.split("\n").map((l) => l.replace(/^[ \t]+/, ""));
  for (const code of DEFINITE_REFUSAL_CODES) {
    if (lines.some((l) => l.startsWith(`❌ [${code}]`))) {
      return { result: "refused_definite", submit: null, inject_id: null, detail: code };
    }
  }
  for (const text of RESOLVER_REFUSALS) {
    if (all.includes(text)) return { result: "refused_definite", submit: null, inject_id: null, detail: text };
  }
  return unknown(`exit_${r.rc}_unrecognised_output`);
}

/** The fixed argv after the telepty binary (SPEC §6.1 step 2; TEST-PLAN C7). The envelope is one element. */
export function sendArgv(target: string, text: string): string[] {
  return ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", SEND_FROM, target, text];
}

/** teleptyChildEnv() (report pump) plus every other `TELEPTY_SESSION_*` key removed (TEST-PLAN C7). */
export function sendChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e = teleptyChildEnv(base);
  for (const k of Object.keys(e)) if (k.toUpperCase().startsWith("TELEPTY_SESSION_")) delete e[k];
  return e;
}

/** The telepty binary, as src/dispatch/cli.ts:52 resolves it. */
export function defaultTeleptyBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.TELEPTY || "telepty";
}

/** True for `<controller_sid>@<peer>` with exactly one `@`, a valid sid and a peer that cannot read as a flag. */
export function validPeerTarget(target: string): boolean {
  const at = target.indexOf("@");
  if (at < 0 || at !== target.lastIndexOf("@")) return false;
  const sid = target.slice(0, at);
  const peer = target.slice(at + 1);
  return SID_RE.test(sid) && peer.length > 0 && peer.length <= 253 && !peer.startsWith("-") && /^[^\s\u0000-\u001f\u007f]+$/.test(peer);
}

// ── injected process runner ─────────────────────────────────────────────────
export interface RunnerResult extends InjectResult {
  /** true when a stream exceeded SEND_OUTPUT_MAX_BYTES (the rest was dropped). */
  truncated: boolean;
}

export interface ProcessRunner {
  /** Runs `bin argv…` without a shell; never rejects. rc null = killed by the timeout or no exit status. */
  run(bin: string, argv: readonly string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunnerResult>;
}

/** The real runner: spawn (cross-spawn on win32, as src/dispatch/cli.ts:1131), stdin ignored, no shell. */
export const defaultProcessRunner: ProcessRunner = {
  run(bin, argv, opts) {
    return new Promise<RunnerResult>((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const size = { out: 0, err: 0 };
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const text = (bufs: Buffer[]): string => Buffer.concat(bufs).toString("utf8");
      const finish = (rc: number | null, note: string): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve({ rc, stdout: text(out), stderr: text(err) + note, truncated });
      };
      let started: ChildProcess | Error;
      try {
        started = (process.platform === "win32" ? crossSpawn : spawn)(bin, [...argv],
          { env: opts.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        started = e instanceof Error ? e : new Error(String(e));
      }
      if (started instanceof Error) {
        finish(null, `\n[controller-link] spawn failed: ${started.message}`);
        return;
      }
      const child = started;
      const keep = (bufs: Buffer[], key: "out" | "err") => (chunk: Buffer): void => {
        const room = SEND_OUTPUT_MAX_BYTES - size[key];
        if (room <= 0) { truncated = true; return; }
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (part.length < chunk.length) truncated = true;
        bufs.push(part);
        size[key] += part.length;
      };
      child.stdout!.on("data", keep(out, "out"));
      child.stderr!.on("data", keep(err, "err"));
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A grandchild may hold the pipes open; do not wait for them forever.
        graceTimer = setTimeout(() => {
          child.stdout!.destroy();
          child.stderr!.destroy();
          finish(null, "\n[controller-link] killed after the send timeout");
        }, KILL_GRACE_MS);
      }, opts.timeoutMs);
      child.on("error", (e) => finish(null, `\n[controller-link] spawn error: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      child.on("close", (code) => finish(timedOut ? null : code, timedOut ? "\n[controller-link] killed after the send timeout" : ""));
    });
  },
};

// ── send ────────────────────────────────────────────────────────────────────
export interface SendDeps {
  runner: ProcessRunner;
  /** default defaultTeleptyBin() */
  bin?: string;
  /** default process.env; reduced by sendChildEnv() */
  baseEnv?: NodeJS.ProcessEnv;
  /** default SEND_TIMEOUT_MS */
  timeoutMs?: number;
}

export type SendOutcome =
  | {
    /** Nothing was spawned. */
    attempted: false;
    code: "PEER_CONFIG_INVALID" | "ENVELOPE_INVALID";
    detail: string;
  }
  | {
    /** telepty was started once (or the runner failed while doing so). */
    attempted: true;
    classification: SendClassification;
    rc: number | null;
    stdout: string;
    stderr: string;
  };

/**
 * SPEC §6.1 steps 2–3: send `text` as the whole text of one inject to `target` and classify it.
 * `text` must be a canonical envelope exactly as stored (U1 parseEnvelope(text).envelope.text === text),
 * so a re-send is always the same bytes. One attempt, no retry, no store access.
 */
export async function sendEnvelope(target: string, text: string, deps: SendDeps): Promise<SendOutcome> {
  if (!validPeerTarget(target)) {
    return { attempted: false, code: "PEER_CONFIG_INVALID", detail: "target is not <controller_sid>@<peer>" };
  }
  const parsed = parseEnvelope(text);
  if (!parsed.ok) return { attempted: false, code: "ENVELOPE_INVALID", detail: `${parsed.error.code}: ${parsed.error.detail}` };
  if (parsed.envelope.text !== text) {
    return { attempted: false, code: "ENVELOPE_INVALID", detail: "text is not the canonical envelope bytes" };
  }
  let r: RunnerResult;
  try {
    r = await deps.runner.run(deps.bin ?? defaultTeleptyBin(), sendArgv(target, text),
      { env: sendChildEnv(deps.baseEnv ?? process.env), timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS });
  } catch (e) {
    return { attempted: true, rc: null, stdout: "", stderr: String((e as Error)?.message ?? e),
      classification: { result: "unknown", submit: null, inject_id: null, detail: "runner_error" } };
  }
  const classification: SendClassification = r.truncated
    ? { result: "unknown", submit: null, inject_id: null, detail: "output_truncated" }
    : classifySend(r);
  return { attempted: true, classification, rc: r.rc, stdout: r.stdout, stderr: r.stderr };
}
