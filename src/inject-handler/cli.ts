// inject-handler — orchestrator-side dispatcher for incoming inject envelopes
// (#899 tranche 5 port of bin/inject-handler.sh, which is now an exec shim).
//
// Every stdout line, every stderr line, every exit code, the holds.log record shape,
// the test-report bytes and all three children's argv are the shell script's,
// preserved deliberately — see tests/dispatch/T124, which is re-runnable against the
// ORIGINAL bash and passes there too.
//
// WHAT THIS FILE IS FOR. Five inject kinds arrive here from worker sessions over the
// PTY channel and each one actuates something: a Layer-D cleanup is armed or deferred,
// a registry observation is appended, an audit line lands in holds.log, a tester's
// structured handoff is written to disk. The envelope is UNAUTHENTICATED — nothing
// binds those bytes to the session they claim to come from — so every field that
// reaches a filesystem path or a child's argv is a trust boundary, and this file is
// where that boundary is enforced.
//
// TWO PRE-EXISTING DEFECTS ARE FIXED RATHER THAN REPRODUCED, on the orchestrator's
// decision. Both reproductions are in
// docs/reports/2026-08-18-899-t5-inject-handler-disposition.md §7, and
// tests/dispatch/T124 blocks J-M assert BOTH sides — the bash's behaviour under
// INJECT_PARITY_ORIGINAL=1 and this file's without it, so neither is a claim:
//
//   D1 (task #928) `payload.grace_seconds` and `payload.defer_minutes` went straight
//      from an unauthenticated envelope into `--grace-seconds` / `--minutes` on
//      bin/dispatch-cleanup-scheduler.sh, behind `>/dev/null 2>&1 || true`. The parser
//      type-checks grace_seconds not at all (validateCleanupRequest,
//      src/session/inject-parser.ts) and neither field is range-checked anywhere:
//        * `"grace_seconds": "soon"` used to truncate the whole fleet's
//          cleanup-pending.json to zero bytes; since tranche 4 the scheduler refuses
//          with rc 1 instead — and `|| true` ate the refusal, so the envelope's
//          cleanup was NEVER ARMED, the ordinary success line still printed, the exit
//          code was still 0, and nothing anywhere recorded it;
//        * a negative grace_seconds wrote a scheduled_cleanup_time in the PAST, i.e.
//          an unauthenticated inject could have the next Layer-D tick retire a live
//          session immediately, and a negative defer_minutes pulled a pending cleanup
//          EARLIER rather than later — the opposite of what EXTEND_LIFETIME means.
//      Both fields are now integers in a sane range or the envelope is refused, and a
//      scheduler call that fails for any OTHER reason is no longer silent either. The
//      two cases are split on purpose, because they are different failures:
//        rejected field  → stderr line naming the field, INJECT_PAYLOAD_REJECTED in
//                          state/dispatch/alerts.log, exit 1, no scheduler call at all
//                          (a malformed payload, which is what `--help` says exits 1
//                          and what tests/dispatch/T24 already required);
//        scheduler rc≠0  → stderr line carrying the rc, CLEANUP_SCHEDULE_FAILED in
//                          alerts.log, EXIT 0 KEPT and the ordinary stdout line
//                          unchanged, because the envelope WAS recognized and "exits 0
//                          on any recognized envelope" is the contract `--help` prints.
//   D2 `payload.session_id` was pasted into the test-report filename after a
//      `typeof === "string"` check and nothing else (validateTestReport), then `mv`'d
//      into place. `"session_id": "../../../pwned"` therefore wrote a `.json` file of
//      ATTACKER-CHOSEN CONTENT anywhere the orchestrator user can write, overwriting
//      whatever was there — state/dispatch/active.json, state/dispatch/
//      cleanup-pending.json, ~/.telepty/config.json. Reproduced end to end before the
//      fix; T124 block M keeps a canary file outside TEST_REPORTS_DIR to prove it
//      cannot happen again. A session_id must now be a single safe path segment. The
//      refusal reuses src/hitl/cli.ts:341's idiom (`[A-Za-z0-9._-]+`, which by
//      construction excludes `/`, NUL and every control character, so a rejected value
//      cannot forge a log line either) plus the `.`/`..` and length checks that a
//      character class cannot express. Same shape as the comms-auditor thread_id
//      traversal fixed in tranche 4.
//
// NOT FIXED, and named so the next reader does not mistake silence for absence —
// each is out of this task's decided scope (Rule 29) and wants its own ticket:
//   * The parser's own validateTestReport still accepts any string as session_id.
//     Moving the segment rule INTO src/session/inject-parser.ts would benefit every
//     consumer, but it turns a refusal that names the field into a generic
//     `parse failed: unknown envelope kind`, and the parser is not this task's surface.
//   * The telemetry `--payload-json` is still assembled by string interpolation, so a
//     `"` in a reason or target still emits invalid JSON (measured: `reason: a"b` →
//     `{"target":"t3","reason":"a"b",…}`). It is REPRODUCED here byte for byte, `|| true`
//     included; T124 blocks E/F/G pin the exact argv.
//   * A `dispatch-registry.py` observe that fails is still swallowed, exactly as
//     `|| true` did. The orchestrator's decision covered the SCHEDULER calls.
//
// DEVIATION (Rule 38). A `reason` that is not a string renders JSON-style rather than
// python's `str()`: the shell read the field through `python3 -c print(p.get(…))`, so
// a JSON `null` reached the scheduler as the literal `None`, `true` as `True` and an
// object as `{'a': 1}`. Only `reason` is affected — `target` is a non-empty string by
// the parser's own check, and the two numeric fields are now validated. Same call, and
// for the same reason, as the comms-auditor port's D4.
//
// The two-layout dist resolution is bin/lib/node-shim.sh's, shared with dispatch.sh,
// dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh, hitl.sh,
// open-session.sh, dispatch-cleanup-scheduler.sh and session-comms-auditor.sh;
// tests/dispatch/T125 pins the workspace layout for this one.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseInject, type ParsedInject } from "../session/inject-parser.js";
import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P`, exported by the shim
// so a symlinked entrypoint still locates bin/ helpers — and so a control workspace
// uses its OWN state/dispatch and state/test-reports rather than the installed
// package's (T125 block C).
// REPO_DIR derived from this file's location would point at the PACKAGE root.
// tests/dispatch/T125 pins that. The fallback keeps a direct
// `node dist/src/inject-handler/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state", "dispatch");
const TEST_REPORTS_DIR = env.TEST_REPORTS_DIR || path.join(REPO_DIR, "state", "test-reports");
const HOLDS_LOG = path.join(STATE_DIR, "holds.log");
const ALERTS_LOG = path.join(STATE_DIR, "alerts.log");
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const SCHEDULER_SH = env.SCHEDULER_SH || path.join(SCRIPT_DIR, "dispatch-cleanup-scheduler.sh");
const EMIT_TELEMETRY_MJS = env.EMIT_TELEMETRY_MJS || path.join(SCRIPT_DIR, "emit-telemetry.mjs");

/** `[ -x "$f" ]` — every child call in the shell was gated on this. */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` */
function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

/** `date -u +%Y-%m-%d` */
function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function die(msg: string, code: number): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

/**
 * The fleet's alert convention — `<utc-iso> <line>` appended to
 * state/dispatch/alerts.log, as src/tracker/cli.ts:222, src/reconciler/cli.ts:314 and
 * bin/orchestrator-bridge-auditor.sh:69 write it. This script never wrote to it before
 * the port; it does now because nothing in production reads this handler's stderr (it
 * has no production caller at all — ADR 2026-07-26 §Context), so stderr alone would
 * have left the D1 failures as invisible as `|| true` did.
 */
function emitAlert(line: string): void {
  try {
    fs.appendFileSync(ALERTS_LOG, `${nowIso()} ${line}\n`);
  } catch {
    /* the alert must never be the thing that breaks the primary path */
  }
}

/** §9 독립: telemetry failure must NEVER block the inject-handler primary path. */
function emitTelemetry(args: string[]): void {
  if (!isExecutable(EMIT_TELEMETRY_MJS)) return;
  try {
    spawnSync(EMIT_TELEMETRY_MJS, args, { stdio: "ignore" });
  } catch {
    /* swallowed, exactly as `|| true` did */
  }
}

/** `"$DISPATCH_REGISTRY_PY" … >/dev/null 2>&1 || true`, `[ -x ]`-gated. */
function registryObserve(args: string[]): void {
  if (!isExecutable(DISPATCH_REGISTRY_PY)) return;
  try {
    spawnSync(DISPATCH_REGISTRY_PY, args, { stdio: "ignore" });
  } catch {
    /* swallowed, exactly as `|| true` did */
  }
}

/**
 * `"$SCHEDULER_SH" "${args[@]}" >/dev/null 2>&1 || true`, `[ -x ]`-gated — but the
 * `|| true` no longer erases the outcome (D1). Exit code and stdout are unchanged; the
 * failure gains one stderr line and one alert.
 */
function schedulerCall(args: string[]): void {
  if (!isExecutable(SCHEDULER_SH)) return;
  let rc: number;
  try {
    rc = spawnSync(SCHEDULER_SH, args, { stdio: "ignore" }).status ?? 1;
  } catch {
    rc = 1;
  }
  if (rc === 0) return;
  const verb = args[0] ?? "";
  const target = args[1] ?? "";
  process.stderr.write(
    `inject-handler: scheduler ${verb} ${target} failed rc=${rc} — the envelope was recognized but its Layer-D action did not happen\n`,
  );
  emitAlert(`CLEANUP_SCHEDULE_FAILED verb=${verb} target=${target} rc=${rc}`);
}

// ── the trust boundary (D1 + D2) ────────────────────────────────────────────

/**
 * One rejection shape for every field refused at the boundary: the operator-readable
 * half on stderr, the greppable half in alerts.log, and exit 1 with nothing written
 * and no child called. The value is JSON-quoted in both, so an envelope carrying a
 * newline cannot forge a second log line.
 */
function rejectField(field: string, kind: string, target: string | null, raw: unknown, why: string): never {
  emitAlert(
    `INJECT_PAYLOAD_REJECTED field=${field} kind=${kind}` +
      (target === null ? "" : ` target=${target}`) +
      ` value=${JSON.stringify(raw ?? null)}`,
  );
  return die(`inject-handler: rejected ${field}=${JSON.stringify(raw ?? null)} in a ${kind} envelope — ${why}`, 1);
}

/**
 * An optional integer field of an unauthenticated payload. Absent stays absent (the
 * flag is simply not passed, as in the shell). Present must be an integer — as a JSON
 * number or as the digit string the fenced path can carry, since the shell passed
 * either straight through and the scheduler's own requireInt accepts both — and must
 * be in range. `min`/`max` are the trust-boundary bounds the scheduler deliberately
 * does not have: it validates integer-ness for ANY caller, including the operator, and
 * an operator is allowed to say `--grace-seconds 999999`.
 */
function optionalBoundedInt(
  raw: unknown,
  field: string,
  kind: string,
  target: string,
  min: number,
  max: number,
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw)) {
    n = Number.parseInt(raw.trim(), 10);
  } else {
    return rejectField(field, kind, target, raw, `expected an integer in ${min}..${max}`);
  }
  if (!Number.isInteger(n)) {
    return rejectField(field, kind, target, raw, `expected an integer in ${min}..${max}`);
  }
  if (n < min || n > max) {
    return rejectField(field, kind, target, raw, `out of range — expected ${min}..${max}`);
  }
  return String(n);
}

/** grace_seconds: 0 .. 24h. The Layer-D default is 60s; a day is already generous. */
const GRACE_MAX = 86400;
/** defer_minutes: 0 .. 24h, the same ceiling expressed in the unit EXTEND uses. */
const DEFER_MAX = 1440;
/** `${sid}.json.tmp.XXXXXX` has to fit in NAME_MAX (255) with room to spare. */
const SID_MAX = 128;
/** src/hitl/cli.ts:341's idiom. Excludes `/`, NUL and every control character. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * D2. A session_id becomes a FILENAME, so it must be one path segment and nothing
 * else. Refused rather than sanitised: a sanitised `../../x` would silently write to
 * a file the sender did not name, and a tester whose sid is mangled should hear about
 * it rather than lose the handoff into a wrong path.
 */
function requireSafeSegment(raw: unknown, field: string, kind: string): string {
  if (typeof raw !== "string" || !SAFE_SEGMENT_RE.test(raw)) {
    rejectField(field, kind, null, raw, `must be one path segment matching [A-Za-z0-9._-]+ — it becomes a filename`);
  }
  if (raw === "." || raw === "..") {
    rejectField(field, kind, null, raw, "must be one path segment, not a directory reference");
  }
  if (raw.length > SID_MAX) {
    rejectField(field, kind, null, raw, `must be at most ${SID_MAX} characters — it becomes a filename`);
  }
  return raw;
}

// ── payload field readers ───────────────────────────────────────────────────

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
}

/**
 * `python3 -c 'print(p.get("reason",""))'`. A missing key was the empty string; any
 * other JSON type was stringified by python. See the Rule 38 deviation in this file's
 * header for the one shape where JSON-style and python-style differ.
 */
function textField(payload: unknown, key: string): string {
  const v = field(payload, key);
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ── argv ────────────────────────────────────────────────────────────────────

function main(): void {
  // `mkdir -p "$STATE_DIR"` ran BEFORE the argv loop in the shell, so even `--help`
  // created it. Kept where it was.
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const argv = process.argv.slice(2);
  let bodyFile = "";
  let sidOverride = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--body-file":
      case "--sid": {
        // `x="$2"; shift 2` under `set -u`. A flag with no value was a
        // locale-dependent `$2: unbound variable` and exit 1 — the code and the FACT
        // of a message are the contract, the wording is the implementation's
        // (T116 block B / T120 set this precedent).
        const v = argv[i + 1];
        if (v === undefined) die(`inject-handler: ${a} requires a value`, 1);
        if (a === "--body-file") bodyFile = v;
        else sidOverride = v;
        i++;
        break;
      }
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        die(`inject-handler: unknown ${a}`, 4);
    }
  }

  let body: string;
  if (bodyFile) {
    try {
      body = fs.readFileSync(bodyFile, "utf8");
    } catch (e) {
      // The shell let node's own ENOENT stack trace out here and exited 1. The code
      // is the contract; a diagnostic instead of a stack trace is strictly better and
      // nothing pinned the text.
      die(`inject-handler: cannot read --body-file ${bodyFile}: ${(e as Error).message}`, 1);
    }
  } else {
    try {
      body = fs.readFileSync(0, "utf8");
    } catch {
      body = "";
    }
  }

  const parsed = parseInject(body);
  if (!parsed.ok) die(`inject-handler: parse failed: ${parsed.error}`, 1);

  const { kind, payload, transport } = parsed.envelope;
  // The exact bytes the inline `node -e` bridge produced, key order included: the hold
  // arm appends this verbatim to holds.log and orchestrator sessions parse it.
  const parsedJson = JSON.stringify({ ok: true, kind, transport, payload });

  switch (kind) {
    case "report":
      armReport(sidOverride, transport);
      break;
    case "cleanup-request":
      armCleanupRequest(payload, transport);
      break;
    case "extend-lifetime":
      armExtendLifetime(payload, transport);
      break;
    case "hold":
      armHold(parsedJson, transport);
      break;
    case "test-report":
      armTestReport(payload, transport, sidOverride);
      break;
    default:
      // Unreachable via parseInject's narrowing, kept because the shell had the arm.
      die(`inject-handler: unrecognized kind=${kind as string}`, 1);
  }
}

type Transport = ParsedInject["transport"];

function armReport(sidOverride: string, transport: Transport): void {
  const sid = sidOverride;
  if (!sid) {
    die("inject-handler: --sid required for REPORT envelopes (markdown subject doesn't carry sid)", 1);
  }
  // The envelope is unauthenticated and uncorrelated: nothing binds these bytes to the
  // dispatch they claim to be reporting. It is recorded, not believed.
  registryObserve([
    "observe", "--sid", sid, "--kind", "legacy_report_envelope_observed",
    "--field", `transport=${transport}`, "--field", "outcome_protocol=unavailable",
    "--field", "reason=stage_b_deferred_to_0.9.0",
  ]);
  // Layer-D cleanup still arms off this envelope: dropping it would end automatic
  // worker retirement fleet-wide. It IS an inference, so it is written down with its
  // basis — when #816/#817 land and Stage B replaces this path, whoever does that work
  // can see exactly what was inferred.
  registryObserve([
    "observe", "--sid", sid,
    "--kind", "cleanup_scheduled_from_legacy_report_envelope",
    "--field", "basis=legacy_report_envelope",
  ]);
  schedulerCall(["schedule", sid, "--grace-seconds", "60", "--source", "legacy-report-envelope"]);
  emitTelemetry([
    "--helper", "report", "--subtype", "report",
    "--payload-json", `{"target_sid":"${sid}","transport":"${transport}"}`,
    "--correlation-id", sid,
  ]);
  console.log(
    `[inject-handler] report kind=report sid=${sid} transport=${transport} — recorded as an observation; outcome_protocol_unavailable (0.8.0 has no terminal outcome); scheduler armed`,
  );
}

function armCleanupRequest(payload: unknown, transport: Transport): void {
  const target = String(field(payload, "target") ?? "");
  const reason = textField(payload, "reason");
  const grace = optionalBoundedInt(field(payload, "grace_seconds"), "grace_seconds", "cleanup-request", target, 0, GRACE_MAX);

  const args = ["schedule", target, "--source", "explicit-request"];
  if (reason) args.push("--reason", reason);
  if (grace !== null) args.push("--grace-seconds", grace);
  schedulerCall(args);

  emitTelemetry([
    "--helper", "lifecycle", "--subtype", "cleanup",
    "--payload-json", `{"target":"${target}","reason":"${reason}","grace_seconds":"${grace ?? ""}","transport":"${transport}"}`,
    "--correlation-id", target,
  ]);
  console.log(`[inject-handler] cleanup-request target=${target} transport=${transport}`);
}

function armExtendLifetime(payload: unknown, transport: Transport): void {
  const target = String(field(payload, "target") ?? "");
  const reason = textField(payload, "reason");
  const defer = optionalBoundedInt(field(payload, "defer_minutes"), "defer_minutes", "extend-lifetime", target, 0, DEFER_MAX);

  if (defer !== null) {
    const args = ["defer", target, "--minutes", defer];
    if (reason) args.push("--reason", reason);
    schedulerCall(args);
    emitTelemetry([
      "--helper", "lifecycle", "--subtype", "extend",
      "--payload-json", `{"target":"${target}","defer_minutes":"${defer}","reason":"${reason}","transport":"${transport}"}`,
      "--correlation-id", target,
    ]);
    console.log(`[inject-handler] extend-lifetime target=${target} defer=${defer}m transport=${transport}`);
    return;
  }
  schedulerCall(["cancel", target]);
  emitTelemetry([
    "--helper", "lifecycle", "--subtype", "extend",
    "--payload-json", `{"target":"${target}","cancel":true,"transport":"${transport}"}`,
    "--correlation-id", target,
  ]);
  console.log(`[inject-handler] extend-lifetime target=${target} cancel-pending transport=${transport}`);
}

function armHold(parsedJson: string, transport: Transport): void {
  // Audit log only — orchestrator session reads this when deciding next phase.
  fs.appendFileSync(HOLDS_LOG, `${nowIso()}\t${parsedJson}\n`);
  emitTelemetry([
    "--helper", "report", "--subtype", "hold",
    "--payload-json", `{"transport":"${transport}"}`,
  ]);
  console.log(`[inject-handler] hold logged transport=${transport}`);
}

function armTestReport(payload: unknown, transport: Transport, sidOverride: string): void {
  // D2: the payload's session_id becomes a filename, so it is validated even when
  // --sid overrides it for the path — an envelope that carries a traversal is a
  // malformed envelope, and whether it happens to be written is the operator's argv,
  // not the sender's business.
  const sidPayload = requireSafeSegment(field(payload, "session_id"), "session_id", "test-report");
  const sid = sidOverride || sidPayload;

  const targetDir = path.join(TEST_REPORTS_DIR, nowDate());
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, `${sid}.json`);

  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  out["_transport"] = transport;
  // `json.dumps(out, indent=2, ensure_ascii=False)` + python's `print` newline. The
  // payload has already been through JSON.stringify once (the shell's node bridge fed
  // python), so no python-only number spelling can reach this point.
  const text = JSON.stringify(out, null, 2) + "\n";

  // Atomic write: tmp + mv, in the target dir so the rename cannot cross a device.
  const tmp = `${targetFile}.tmp.${process.pid}.${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, targetFile);

  emitTelemetry([
    "--helper", "report", "--subtype", "test_report",
    "--payload-json", `{"target_sid":"${sid}","path":"${targetFile}","transport":"${transport}"}`,
    "--correlation-id", sid,
  ]);
  console.log(`[inject-handler] test-report written sid=${sid} path=${targetFile} transport=${transport}`);
}

main();
