// orchestrator-boot — the STANDARD control-tower (orchestrator) boot wrapper (#539,
// #905), ported from bin/orchestrator-boot.sh by #899 tranche 5 (ob899).
//
// Spec:        docs/specs/2026-06-13-orchestrator-bridge-singleton-enforcement.md
//              (its SIGKILL guard and DELETE reconcile are superseded by task 1270's
//              create-only boot preflight; see THE ORDER IS THE CONTRACT below)
// Runbook:     docs/runbooks/2026-08-16-orchestrator-restart.md
// Disposition: docs/reports/2026-08-18-899-t5-orchestrator-boot-disposition.md
//              (every measurement cited below was taken against the original bash
//              at b300875 with ps/kill/telepty/curl recorder stubs — no real pid was
//              ever listed or signalled and no real DELETE was ever issued)
//
// THE ORDER IS THE CONTRACT (task 1270): resolve and confirm the plan, validate capture, run the
// bounded exact-local BOOT PREFLIGHT, and — only when it answers FRESH — hand the exec argv back to
// bin/orchestrator-boot.sh so THE USER'S SHELL — not this process — becomes the bridge.
//
// ⚠️ THREE INVARIANTS, none of them negotiable:
//
//   1. NOTHING EXISTING IS DESTROYED OR TAKEN OVER. Task 1270 removed the singleton SIGKILL guard
//      (#539) and the STALE-record DELETE reconcile (#905) together with their `ps`, `kill`,
//      `telepty list` and `curl -X DELETE` calls and their `__probe` doors. A boot no longer lists
//      processes or sessions, signals anything or deletes anything. Instead it boots with the
//      versioned create-only verb `telepty allow-create-v1`, and only after the preflight found NO
//      session with the chosen id. A session that exists is reported (EXISTS_IDENTITY_UNPROVEN) and
//      left alone: it is never attached by name, command, cwd or pid, killed or replaced. Every
//      verdict other than FRESH is exit 3 with an empty stdout. A creation race after FRESH is
//      decided by the daemon's own create_only (409, no app) — never by a retry here.
//   2. THE EXEC STAYS A REAL PROCESS REPLACEMENT. Node has no execve, so this file does NOT spawn the
//      bridge. It prints the argv on stdout, one element per line, and bin/orchestrator-boot.sh —
//      the process the user's terminal launched — `exec`s it. Node has already exited by then, so
//      the shell becomes the bridge and no node generation is left in the middle to swallow a signal
//      or a TTY.
//   3. THE TOKEN IS NEVER LOGGED. It goes into the curl header argument and nowhere else, exactly as
//      bin/lib/telepty-auth.sh requires.
//
// STDOUT IS A CONTRACT CHANNEL. Logs go to stderr; stdout carries the exec argv. So no child of
// this process may inherit stdout: `telepty`, `curl` and the credential door are all captured or
// ignored below, never `inherit`. A stray byte on stdout would be exec'd.
//
// D1 — an ORCHESTRATOR_SID containing a CONTROL CHARACTER is refused with exit 2 instead of booting.
// The argv crosses back to the shim as newline-delimited text, so a sid containing a newline would
// split one argv element into two and the shell would exec a corrupted command line. Exit 2 shares
// its code with bin/lib/node-shim.sh's "dist not found"; the stderr line names the field.
//
// Article 17 (무의존): node stdlib. `telepty`, `curl` and the ONE sanctioned credential resolver
// (bin/lib/telepty-auth.sh, #824 — sourced through a bash door, never re-implemented) stay
// subprocesses. Rule 26: zero platform branches.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { USAGE } from "./usage.js";
// #1181 — the boot plan. `plan.ts` is PURE (it is handed the environment, it reads none),
// `wizard.ts` owns fd 0 and fd 2 and never touches fd 1, and `provider-capabilities.ts` is a
// frozen literal that no code path executes a provider to populate. All three are imported
// HERE, at the top of the one module the shim runs, and the plan they produce is resolved
// BEFORE the first effect below.
import {
  BOOT_CAPABILITIES_SCHEMA,
  bootCapabilitiesDocument,
  type BootPlan,
  type HandoffPreview,
  type InputPolicy,
  INPUT_POLICY_CLIENT_ENV,
  PLAN_ENV,
  buildExecArgv,
  describeEffects,
  describePlan,
  handoffArgv,
  handoffDeliveryLabel,
  handoffDeliveryRecord,
  handoffRefusal,
  parseEnvPlan,
  planEnvLines,
} from "./plan.js";
import { runWizard } from "./wizard.js";
// #1162 — the display-only controller boot record. Written once, from main() only.
import { type PlanSource, controllerRecordRoot, writeControllerBootRecord } from "./boot-record.js";

const env = process.env;

// ── the modes (#934) ────────────────────────────────────────────────────────
// THE INCIDENT: on 2026-08-18 the orchestrator ran `bin/orchestrator-boot.sh --help |
// head -2` as a smoke check and got the REAL boot — reconcile, SIGKILL guard, exec —
// because argv was not read on the boot path at all. Nothing was harmed that day and
// the original bash behaved identically, so the port was faithful; the footgun is the
// design. A script that SIGKILLs processes and DELETEs a registry record had no way to
// be LOOKED AT without acting.
//
// The fix is a shape, not a flag list. bin/orchestrator-boot.sh now execs node for ANY
// non-empty argv, so the boot path — the command substitution that reads the exec argv
// and the `exec` that runs it — is reachable only when argv is EMPTY. Adding a mode
// here therefore cannot regress into an accidental boot: falling through to the exec
// requires having no argv at all, which no mode has.
//
// `__probe` (below) keeps its own door for the same reason it always had one.
//
// Measured on 1088ad7 before this landed, with ps/kill/telepty/curl recorders:
// `--help`, `-h`, `--dry-run` and `--bogus-flag` all ran the reconcile, SIGKILLed the
// fixture bridge and exec'd, each exiting 0. There was no unknown-flag arm to preserve.
//
// #1181 ADDS ONE MODE AND NO NEW BOOT DOOR. `--wizard-plan` collects a plan and PRINTS it;
// like every other non-empty argv it can never reach the exec, because the shim execs node
// for any argv at all. The wizard itself is therefore NOT a flag: it runs on the EMPTY-argv
// boot path, where the shim's command substitution leaves fd 0 and fd 2 attached to the
// operator's terminal and takes only fd 1 for the argv.
type Mode = "boot" | "probe" | "help" | "dry-run" | "wizard-plan" | "unknown";
const CLI_ARGV = process.argv.slice(2);
// argv[0] alone, and only when it is the ONLY token: `--dry-run --help` is a refusal
// rather than a guess at which mode was meant. Nothing may be smuggled in behind a
// recognised flag on a script whose bare form boots a control tower.
//
// Probes retain their stdout argv/stderr diagnostics, but suppress every mutation
// through the same effect gate as dry-run. Inspection must never DELETE or signal.
const MODE: Mode =
  CLI_ARGV.length === 0
    ? "boot"
    : CLI_ARGV[0] === "__probe"
      ? "probe"
      : CLI_ARGV.length === 1 && (CLI_ARGV[0] === "--help" || CLI_ARGV[0] === "-h")
        ? "help"
        : CLI_ARGV.length === 1 && CLI_ARGV[0] === "--dry-run"
          ? "dry-run"
          : CLI_ARGV.length === 1 && CLI_ARGV[0] === "--wizard-plan"
            ? "wizard-plan"
            : "unknown";
const DRY_RUN = MODE === "dry-run" || MODE === "probe";
// Every mode but `boot` and `__probe`. Used for the stream choice and the EPIPE arm
// below, both of which must leave the boot path byte-identical.
const NO_EXEC = MODE === "help" || MODE === "dry-run" || MODE === "wizard-plan" || MODE === "unknown";

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` (bash :61). The shim
// exports it so a symlinked entrypoint still locates bin/lib/telepty-auth.sh; the
// fallback keeps a direct `node dist/src/orchestrator-boot/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const TELEPTY_AUTH_SH = path.join(SCRIPT_DIR, "lib/telepty-auth.sh");

// Configurable orchestrator sid — same source as bin/dispatch-tracker.sh (Rule 16, no
// hardcode). `:-` semantics: an EMPTY value falls back to the default, as in bash.
//
// This is the sid the D1 refusal below screens and the sid the wizard SUGGESTS. It is not
// necessarily the sid this boot ends up using: the wizard may be given another one, so the
// preflight takes the RESOLVED sid as an argument (#1181). Looking up the env value instead
// would answer for a session this boot is not about to become.
const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";
// ORCHESTRATOR_CLI is read in plan.ts now, as one required field of an explicit plan
// (v2/R2). There is no module-level default here any more, because a defaulted provider was
// how `ORCHESTRATOR_CLI` alone came to authorise a bypass-and-resume argv nobody chose.

// The preflight's seams. CURL is the http client for the two bounded local GETs (the test seam the
// hermetic suites already use); TELEPTY_PORT is the port telepty itself resolves for the canonical
// host. Task 1270 removed KILL_CMD, SINGLETON_PS_CMD, SINGLETON_SELF_PID and TELEPTY (the `list`
// seam) with the guard and the reconcile they served.
const CURL_CMD = env.CURL || "curl";
const TELEPTY_PORT = env.TELEPTY_PORT || "3848";

// fs.writeSync rather than process.stdout.write: writes to a pipe are asynchronous in
// node and this process exits explicitly, so a buffered argv line could be truncated
// on its way to the shim's command substitution. Both streams use it so ordering
// between them is the ordering of the calls.
function log(msg: string): void {
  writeOut(LOG_FD, `[orchestrator-boot] ${LOG_TAG}${msg}\n`);
}

// ── where a no-exec mode's output goes (#934) ───────────────────────────────
// On the boot path (and through `__probe`) this is fd 2 with no tag, byte for byte
// what it always was: stdout there is the exec-argv contract channel and a stray byte
// on it would be exec'd.
//
// In a no-exec mode stdout is NOT a contract channel — the shim exec'd node and reads
// nothing back — so the whole report goes to fd 1 in one ordered stream, which is what
// makes `--dry-run > report.txt` capture all of it.
//
// The `[dry-run] ` tag marks every report line of a run that acted on nothing.
//
// ⚠️ TWO MODES ARE EXEMPT, and both send every diagnostic to fd 2 — including the D1
// control-character refusal below, the one message that reaches an fd through this
// constant rather than a literal. `--wizard-plan` (#1181): stdout is a MACHINE-REUSABLE
// ENVIRONMENT, `NAME=value` lines on success and nothing on an ordinary refusal or
// cancellation. The unknown-flag arm: its documented contract is stderr-only, so
// `… --bogus > out` leaves `out` empty (#1181). `--help`, `--dry-run`, `__probe` and the
// boot path keep the fd they always had — per-mode exemptions, not a logging change.
const LOG_FD = NO_EXEC && MODE !== "wizard-plan" && MODE !== "unknown" ? 1 : 2;
const LOG_TAG = DRY_RUN ? "[dry-run] " : "";

/**
 * fs.writeSync with ONE arm added: an EPIPE in a no-exec mode is not an error.
 *
 * `bin/orchestrator-boot.sh --help | head -2` is the literal command line from the
 * 2026-08-18 incident, and a usage that answers it with an uncaught EPIPE and a stack
 * trace has not really been made safe to look at.
 *
 * DELIBERATELY NOT ON THE BOOT PATH. `bin/orchestrator-boot.sh 2>&1 | head -1` today
 * kills node on the stderr EPIPE, `set -e` aborts the shim, and NOTHING is exec'd.
 * Swallowing it there would let the run continue, print the argv and boot — turning a
 * non-boot into a boot, which is this ticket's failure mode with the sign flipped.
 */
function writeOut(fd: number, s: string): void {
  try {
    fs.writeSync(fd, s);
  } catch (e) {
    if (!NO_EXEC || (e as NodeJS.ErrnoException)?.code !== "EPIPE") throw e;
  }
}

/** `$(...)`: strip ALL trailing newlines, as command substitution does. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

// ── D1: the sid crosses back to the shim as text ────────────────────────────
// A control character in the sid would split the argv (newline) or corrupt the one token the
// bridge and the preflight's session lookup carry. Refusing is the only answer that cannot
// produce a wrong exec.
// A regex would need an escaped range here; a code-point scan needs no escaping at
// all, which is one less thing for a copy of this file to get wrong.
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === undefined) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// `--help` is exempt (#934) and nothing else is. It is what an operator runs when
// already confused, and refusing to PRINT TEXT because of an unrelated env var is the
// same family of footgun this refusal belongs to. `--dry-run` keeps it: it prints the
// sid and the would-exec argv, which is exactly the round trip D1 protects.
if (MODE !== "help" && hasControlChar(ORCH_SID)) {
  writeOut(
    LOG_FD,
    `[orchestrator-boot] ORCHESTRATOR_SID contains a control character — refusing to boot (the exec argv is handed back to the shim as text, and a sid that cannot survive that round trip cannot be exec'd correctly)\n`,
  );
  process.exit(2);
}

// ── the plan, and the TWO ways a boot can get one (#1181, v2) ───────────────
//
// WIZARD        empty argv AND a terminal on both the channel the wizard reads (fd 0) and
//               the channel it draws on (fd 2). The shim's command substitution takes fd 1
//               only, so this is the shape a human at a prompt actually has.
// EXPLICIT PLAN AIGENTRY_BOOT_PLAN=1 plus a COMPLETE, validated set of fields. For a caller
//               with no terminal this is the ONLY door, and it fails closed: a missing
//               permission or history choice is exit 2 before any read.
//
// THERE IS NO THIRD WAY, and that is the correction this revision makes. Until now
// `ORCHESTRATOR_CLI=claude|codex` alone, with no terminal, booted a hardcoded
// `--dangerously-skip-permissions --continue` (or codex's
// `resume --last --dangerously-bypass-approvals-and-sandbox`). That argv chose a permission
// BYPASS and a session RESUME on the operator's behalf, from a variable that names neither,
// which is exactly what #1181 exists to end. It is gone: an environment that has not stated
// its permission and history choices cannot boot at all.
//
// WHAT THE STDOUT-ARGV CONTRACT MEANS HERE. It is the serialization channel for the FINAL
// VALIDATED command — one element per line, for the shell to exec. It was never a promise
// that a particular risky default would keep appearing on it. Inherited guards that assert
// the old default argv from a bare non-TTY invocation are therefore expected to be updated,
// deliberately, by the independent tester; the product behaviour they pin is forbidden now.
//
// TTY ENV VALUES ARE SUGGESTIONS. On the wizard path nothing in the environment confirms
// anything: ORCHESTRATOR_SID pre-fills a prompt the operator still presses Enter on, and
// ORCHESTRATOR_CLI is displayed as a hint next to a list the operator still chooses from.
const PLAN_FIELDS = [PLAN_ENV.model, PLAN_ENV.effort, PLAN_ENV.permission, PLAN_ENV.history, PLAN_ENV.ack] as const;
const PLAN_FLAG = env.AIGENTRY_BOOT_PLAN;
const PLAN_FIELD_SET = PLAN_FIELDS.filter((name) => {
  const v = env[name];
  return v !== undefined && v !== "";
});
// Unknown/multiple modes refuse: the ONLY accepted value is "1". A caller that wrote
// `AIGENTRY_BOOT_PLAN=true` must be told, not silently treated as having no plan.
if (MODE !== "help" && PLAN_FLAG !== undefined && PLAN_FLAG !== "" && PLAN_FLAG !== "1") {
  writeOut(2, `orchestrator-boot.sh: ${PLAN_ENV.enable} must be exactly '1' (got '${PLAN_FLAG}')\n`);
  writeOut(2, `${USAGE}\n`);
  process.exit(2);
}
const PLAN_REQUESTED = PLAN_FLAG === "1";
// A plan field set without the opt-in is a refusal, not an ignore. Silently dropping a
// permission axis a caller took the trouble to set is the worst outcome available here.
if (MODE !== "help" && !PLAN_REQUESTED && PLAN_FIELD_SET.length > 0) {
  writeOut(
    2,
    `orchestrator-boot.sh: ${PLAN_FIELD_SET.join(", ")} set without ${PLAN_ENV.enable}=1 — refusing to ` +
      "ignore an explicit boot plan\n",
  );
  writeOut(2, `${USAGE}\n`);
  process.exit(2);
}
const WIZARD_TTY = process.stdin.isTTY === true && process.stderr.isTTY === true;

// ── task 1215: the declared telepty input policy, resolved ONCE, before any effect ──
// Telepty refuses TELEPTY_SUPERVISION_CLIENT_FILE without `--input-policy user-supervised`,
// and it refuses AFTER exec. So the flag is derived from the variable alone (the pair cannot be
// split), and the declaration is ADMITTED HERE: before the wizard, the capture validation and
// the boot preflight. Unset or empty = no policy, no check, and the
// argv is byte-identical to before. Only the modes that resolve an exec argv take part (boot,
// --dry-run, __probe); --help, --wizard-plan and the unknown-flag arm never check.
//
// boot42: THE ADMISSION IS TELEPTY'S OWN. This file keeps only the argv-safety checks below;
// every client-file, key, nested-session and conflict rule is decided by
// `telepty allow-check --input-policy user-supervised` — the same local admission a real
// `telepty allow` runs — spawned from PATH, i.e. the binary the shell will exec, NOT the
// TELEPTY list seam. No second client validator lives here. A pass means "the local
// configuration was admitted"; it is NOT proof of daemon trust, network liveness or a grant,
// and the file/binary/env can still change between the last check and the exec.
function inputPolicyRefusal(file: string): string | null {
  if (hasControlChar(file)) return "contains a control character";
  if (!path.isAbsolute(file)) return "is not an absolute path";
  return null;
}

const ALLOW_CHECK_ARGV = ["allow-check", "--input-policy", "user-supervised"] as const;
const ALLOW_CHECK_SCHEMA = "telepty.allow-admission/v1";
const ALLOW_CHECK_TIMEOUT_MS = 10000;
const ALLOW_CHECK_RELAY_BYTES = 2048;

/** The checker's own words, flattened and bounded: no control character reaches the terminal. */
function allowCheckRelay(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  const bytes = Buffer.from(flat, "utf8");
  return bytes.length <= ALLOW_CHECK_RELAY_BYTES ? flat : `${bytes.subarray(0, ALLOW_CHECK_RELAY_BYTES).toString("utf8")}…`;
}

/**
 * ONE bounded run of the shared admission. Success is exactly: no spawn error, exit 0, no
 * signal, and stdout is ONE line holding one JSON object with schema telepty.allow-admission/v1,
 * ok:true, input_policy "user-supervised" and supervision_client "loaded". Anything else is a
 * refusal — including an older telepty, which answers an unknown subcommand with help + exit 0.
 */
function allowCheckRefusal(): { readonly reason: string; readonly detail: string } | null {
  const r = spawnSync("telepty", [...ALLOW_CHECK_ARGV], {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: ALLOW_CHECK_TIMEOUT_MS,
    maxBuffer: 65536,
    encoding: "utf8",
  });
  const stdout = r.stdout ?? "";
  const detail = allowCheckRelay(`${stdout} ${r.stderr ?? ""}`);
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { reason: "could not run: no 'telepty' on PATH", detail };
  if (code === "ETIMEDOUT") return { reason: `did not answer within ${ALLOW_CHECK_TIMEOUT_MS} ms`, detail };
  if (r.error !== undefined) return { reason: `could not run (${code ?? "spawn error"})`, detail };
  if (r.signal !== null) return { reason: `was terminated by ${r.signal}`, detail };
  if (r.status !== 0) return { reason: `refused (exit ${String(r.status)})`, detail };
  const line = stdout.trim();
  if (line === "" || line.includes("\n"))
    return { reason: "did not print exactly one admission line (a telepty without allow-check prints its help and exits 0)", detail };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { reason: "printed a line that is not JSON", detail };
  }
  const o: Record<string, unknown> = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (o.schema !== ALLOW_CHECK_SCHEMA || o.ok !== true || o.input_policy !== "user-supervised" || o.supervision_client !== "loaded")
    return {
      reason: `did not answer a ${ALLOW_CHECK_SCHEMA} success (ok true, input_policy user-supervised, supervision_client loaded)`,
      detail,
    };
  return null;
}

/** Exit 2 with an empty stdout unless the shared admission passes. `when` names the call site. */
function refuseUnlessAdmitted(when: string): void {
  const refusal = allowCheckRefusal();
  if (refusal === null) return;
  writeOut(
    2,
    `orchestrator-boot.sh: 'telepty ${ALLOW_CHECK_ARGV.join(" ")}' ${refusal.reason} ${when} — refusing to boot. ` +
      "Nothing was listed, reconciled, signalled, deleted or exec'd.\n",
  );
  if (refusal.detail !== "") writeOut(2, `orchestrator-boot.sh: telepty said: ${refusal.detail}\n`);
  process.exit(2);
}

const INPUT_POLICY: InputPolicy | undefined = ((): InputPolicy | undefined => {
  if (MODE !== "boot" && MODE !== "dry-run" && MODE !== "probe") return undefined;
  const file = env[INPUT_POLICY_CLIENT_ENV];
  if (file === undefined || file === "") return undefined;
  const why = inputPolicyRefusal(file);
  if (why !== null) {
    writeOut(
      2,
      `orchestrator-boot.sh: ${INPUT_POLICY_CLIENT_ENV} ${why} — refusing to boot. Nothing was listed, ` +
        "reconciled, signalled, deleted or exec'd. Unset it for an unsupervised boot, or name the client " +
        "file by absolute path.\n",
    );
    process.exit(2);
  }
  refuseUnlessAdmitted("before any effect");
  return "user-supervised";
})();

// ── the boot preflight (task 1270) ──────────────────────────────────────────
// Three bounded, exact-local questions, asked after the plan is confirmed and capture is
// validated, and before the handoff write, the boot record and the argv. Only FRESH boots.
//
//   TARGET_REFUSED            TELEPTY_HOST is not unset/127.0.0.1, or TELEPTY_PORT is not a port —
//                             decided before any process or request. No alias, peer list,
//                             host:port suffix or scheme redirect is followed.
//   UNSUPPORTED               the telepty on PATH does not print the sealed boot-capabilities
//                             document (an older telepty answers an unknown verb with help and
//                             exit 0, which is NOT support), or /api/meta's existing capabilities
//                             array lacks wrapped-sessions or register-create-only.
//   CREDENTIAL_REFUSED        401/403 from either request.
//   UNKNOWN                   no answer within the bound, a non-JSON body, an alias or a different
//                             id, or any other status.
//   EXISTS_IDENTITY_UNPROVEN  a session with exactly this id exists. Nothing here can prove it is
//                             the session this operator means, so it is not attached, replaced,
//                             killed or deleted.
//   FRESH                     404 for exactly this id: boot with `telepty allow-create-v1`.
type PreflightVerdict = "FRESH" | "EXISTS_IDENTITY_UNPROVEN" | "CREDENTIAL_REFUSED" | "UNSUPPORTED" | "UNKNOWN" | "TARGET_REFUSED";
interface Preflight {
  readonly verdict: PreflightVerdict;
  readonly reason: string;
  /**
   * #1293 (review R2, F5; r3) — the second line, present only when a fact justifies it:
   * TELEPTY_REQUIREMENT when no telepty is on PATH or its valid capability document lacks a
   * capability, TELEPTY_DAEMON_REQUIREMENT (facts only, no host-changing advice) for a daemon whose
   * /api/meta does not list one. Every other UNSUPPORTED — no bash, a timeout, a signal, a spawn
   * error, a non-zero exit, output that is not a valid document — establishes nothing and carries none.
   * The VERDICT is unchanged in every case; only the second stderr line is conditional.
   */
  readonly requirement?: string;
}

const PREFLIGHT_TIMEOUT_MS = 5000;
const PREFLIGHT_OUTPUT_BYTES = 1024 * 1024;
const CREATE_VERB = "allow-create-v1";
const REQUIRED_DAEMON_CAPS = ["wrapped-sessions", "register-create-only"] as const;
// #1293 — this package declares NO dependency on @dmsdc-ai/aigentry-telepty. The boot door execs the
// `telepty` word through PATH (bootDoor below), so a nested copy would never be executed here while
// its postinstall WOULD still run on the host. Install advice follows only an ESTABLISHED fact (r3):
// no telepty on PATH at all, or a valid capability document that lacks a capability. The
// CAPABILITY is what is checked; the version is only NAMED, as the first published telepty carrying
// every verb this orchestrator uses (dispatch's inject-bound-v1 is the latest of them).
const TELEPTY_MIN_VERSION = "0.11.1";
const TELEPTY_INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const TELEPTY_REQUIREMENT =
  "aigentry-orchestrator declares no dependency on @dmsdc-ai/aigentry-telepty and drives the telepty on PATH, so " +
  `nothing here installs, upgrades, starts, stops or restarts it: install @dmsdc-ai/aigentry-telepty ${TELEPTY_MIN_VERSION} ` +
  `or later yourself with '${TELEPTY_INSTALL_COMMAND}', then run this boot again.`;
const TELEPTY_DAEMON_REQUIREMENT =
  "the telepty CLI on PATH passed its capability check; the daemon answering on this port does not list those " +
  "capabilities in GET /api/meta. Compare the version that /api/meta reports with the version the telepty CLI " +
  "prints for its --version flag before you change anything; nothing here starts, stops or restarts the daemon.";

/** An untrusted value for a diagnostic: JSON-quoted (control characters escaped) and bounded. */
function shown(v: string): string {
  return JSON.stringify(v.length > 64 ? `${v.slice(0, 64)}…` : v);
}

/** One JSON object, or null for anything else (array, scalar, null, unparseable). */
/**
 * The sid as ONE strict RFC 3986 path segment: every character outside the unreserved set is percent-encoded.
 * encodeURIComponent leaves ' ( ) * ! raw, and a raw quote does not survive every OS argument transport — measured on
 * native Windows (CI 43736341103), where Git Bash's argv parser dropped a lone `'` from the unquoted URL element on its
 * way through the boot command door. Fully encoded, the URL is plain data on every platform and decodes to the exact sid.
 */
function sidPathSegment(sid: string): string {
  return encodeURIComponent(sid).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The canonical local target, or the refusal. Pure: no process, no request. */
function preflightTarget(): { readonly port: string } | Preflight {
  const host = env.TELEPTY_HOST;
  if (host !== undefined && host !== "" && host !== "127.0.0.1")
    return {
      verdict: "TARGET_REFUSED",
      reason: `TELEPTY_HOST is ${shown(host)}; only unset or exactly 127.0.0.1 is accepted (no alias, peer, port suffix or scheme)`,
    };
  if (!/^[1-9][0-9]{0,4}$/.test(TELEPTY_PORT) || Number(TELEPTY_PORT) > 65535)
    return { verdict: "TARGET_REFUSED", reason: `TELEPTY_PORT is ${shown(TELEPTY_PORT)}; a port number 1-65535 is required` };
  return { port: TELEPTY_PORT };
}

/**
 * The ONE way the preflight starts a child (task 1270, orch-windows-preflight). It is the same explicit door
 * teleptyAuthToken() uses: `bash -c` with FIXED script text — the type admits only the two literals below — and every value
 * as a positional argument, never part of the text. So `telepty` and CURL resolve exactly as the boot shell's own `exec`
 * will: npm's sh shim under Git Bash on win32, where a direct shell:false spawn of an npm shim cannot start; PATH binaries on
 * POSIX. Both scripts `exec`, so the timeout and kill reach the probe or curl itself. `exec --` keeps a CURL value that
 * begins with '-' from being read as an exec option. BASH_ENV/ENV are removed, so this non-interactive bash sources no file.
 */
type BootDoorScript = "exec telepty boot-capabilities" | 'exec -- "$@"';
const BOOT_DOOR_ENV: NodeJS.ProcessEnv = (() => {
  const e: NodeJS.ProcessEnv = { ...env };
  delete e.BASH_ENV;
  delete e.ENV;
  return e;
})();
function bootDoor(script: BootDoorScript, args: readonly string[], stderr: "pipe" | "ignore", timeout: number, maxBuffer: number) {
  return spawnSync("bash", ["-c", script, "_", ...args], {
    env: BOOT_DOOR_ENV,
    shell: false,
    stdio: ["ignore", "pipe", stderr],
    timeout,
    maxBuffer,
    encoding: "utf8",
  });
}

/**
 * #1293 r3 (review R3-6): bash exits 127 both for "command not found" and when the telepty it ran
 * exits 127 itself, so a 127 is read as "no telepty" only when no PATH entry holds a `telepty`
 * file — the lookup bash made, repeated without running anything. PATH unset: unknown.
 * r4 (review R4-4): absence is established only by ENOENT/ENOTDIR for every candidate; any other
 * answer (an unreadable directory, say) leaves it unknown.
 * r5 (review R5-3): each entry is looked up LITERALLY as `<entry>/telepty`, never normalised, so a
 * `link/..` component resolves through the kernel as bash's own lookup does. On win32 the door's
 * bash is Git for Windows' MSYS bash, whose command lookup this walk has not been shown to
 * reproduce, so a win32 127 never establishes absence: inconclusive, no install advice.
 */
function noTeleptyOnPath(): boolean {
  const dirs = BOOT_DOOR_ENV.PATH;
  if (dirs === undefined || process.platform === "win32") return false;
  return dirs.split(path.delimiter).every((dir) => {
    try {
      fs.statSync(dir === "" ? "telepty" : `${dir}/telepty`);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  });
}

/**
 * `telepty boot-capabilities` from PATH — the binary the shell will exec — through the boot command door.
 * Supported ONLY when: exit 0, no signal, stdout exactly one line + newline holding one JSON object
 * with EXACTLY the keys schema/verbs/viewer_detach, schema telepty-boot-capabilities-v1, verbs an
 * array of unique strings containing allow-create-v1, viewer_detach nondeleting-v1.
 */
function bootCapabilitiesRefusal(): { readonly reason: string; readonly confirmed: boolean } | null {
  // #1293: `inconclusive` is any answer that does not ESTABLISH a missing or older telepty — it
  // carries the same UNSUPPORTED verdict and the same first stderr line as before, and no advice.
  const inconclusive = (reason: string) => ({ reason, confirmed: false });
  const confirmed = (reason: string) => ({ reason, confirmed: true });
  const r = bootDoor("exec telepty boot-capabilities", [], "pipe", PREFLIGHT_TIMEOUT_MS, 4096);
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return inconclusive("no 'bash' for the boot command door");
  // bash's own "command not found" for the fixed `telepty` word.
  if (r.error === undefined && r.signal === null && r.status === 127)
    return noTeleptyOnPath() ? confirmed("no 'telepty' on PATH (bash exit 127)")
      : inconclusive("'telepty boot-capabilities' exited 127, and a look at PATH did not establish that no 'telepty' is there, so that exit may be its own");
  if (code === "ETIMEDOUT") return inconclusive(`'telepty boot-capabilities' did not answer within ${PREFLIGHT_TIMEOUT_MS} ms`);
  if (r.error !== undefined) return inconclusive(`'telepty boot-capabilities' could not run (${code ?? "spawn error"})`);
  if (r.signal !== null) return inconclusive(`'telepty boot-capabilities' was terminated by ${r.signal}`);
  if (r.status !== 0) return inconclusive(`'telepty boot-capabilities' exited ${String(r.status)}`);
  const out = r.stdout ?? "";
  if (!out.endsWith("\n") || out.indexOf("\n") !== out.length - 1)
    return inconclusive("'telepty boot-capabilities' did not print exactly one line (an older telepty prints its help and exits 0)");
  // r3: only a WELL-FORMED v1 document that lacks the verb or the detach establishes an older telepty.
  // r4 (review R4-3): well-formed includes a string viewer_detach; null or any other type is malformed.
  // r5 (review R5-2): the well-formedness rule is plan.ts bootCapabilitiesDocument, shared with dispatch.
  const doc = bootCapabilitiesDocument(out);
  if (doc === null || !doc.verbs.includes(CREATE_VERB) || doc.viewer_detach !== "nondeleting-v1")
    return (doc !== null ? confirmed : inconclusive)(
      `'telepty boot-capabilities' did not print a ${BOOT_CAPABILITIES_SCHEMA} document with ${CREATE_VERB} and nondeleting-v1 viewer detach`);
  return null;
}

/**
 * The ONE sanctioned credential resolver (#824), called as the shell function it is —
 * identical to src/cleanup/cli.ts:129 and src/tracker/cli.ts. Degrades to "" (no
 * credential presented) exactly as the lib does, and the value is never logged.
 */
function teleptyAuthToken(): string {
  const r = spawnSync("bash", ["-c", '. "$1"; telepty_auth_token', "_", TELEPTY_AUTH_SH], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return chomp(r.stdout || "");
}

/**
 * ONE bounded GET to the canonical local daemon through the CURL seam: no proxy, http only, no
 * redirect following (curl's default), `--max-time` plus a process timeout and an output bound.
 * `status` is null for anything that is not a complete HTTP answer (timeout, refused, no code).
 */
function localGet(port: string, pathname: string, token: string): { readonly status: number | null; readonly body: string } {
  const c = bootDoor(
    'exec -- "$@"',
    [
      CURL_CMD,
      "-s",
      "--noproxy",
      "*",
      "--proto",
      "=http",
      "--max-time",
      String(PREFLIGHT_TIMEOUT_MS / 1000),
      "-w",
      "\n%{http_code}",
      "-H",
      `x-telepty-token: ${token}`,
      `http://127.0.0.1:${port}${pathname}`,
    ],
    "ignore",
    PREFLIGHT_TIMEOUT_MS + 2000,
    PREFLIGHT_OUTPUT_BYTES,
  );
  if (c.error !== undefined || c.signal !== null || c.status !== 0) return { status: null, body: "" };
  const out = c.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const code = out.slice(nl + 1);
  if (nl < 0 || !/^[1-5][0-9]{2}$/.test(code)) return { status: null, body: "" };
  return { status: Number(code), body: out.slice(0, nl) };
}

function bootPreflight(sid: string): Preflight {
  const target = preflightTarget();
  if ("verdict" in target) return target;
  const capRefusal = bootCapabilitiesRefusal();
  if (capRefusal !== null)
    return { verdict: "UNSUPPORTED", reason: capRefusal.reason, ...(capRefusal.confirmed ? { requirement: TELEPTY_REQUIREMENT } : {}) };
  const token = teleptyAuthToken();
  const meta = localGet(target.port, "/api/meta", token);
  if (meta.status === 401 || meta.status === 403) return { verdict: "CREDENTIAL_REFUSED", reason: `GET /api/meta answered ${meta.status}` };
  if (meta.status !== 200)
    return { verdict: "UNKNOWN", reason: meta.status === null ? "GET /api/meta gave no complete answer within the bound" : `GET /api/meta answered ${meta.status}` };
  const m = jsonObject(meta.body);
  if (m === null) return { verdict: "UNKNOWN", reason: "GET /api/meta answered 200 without a JSON object" };
  const caps = m.capabilities;
  const missing = REQUIRED_DAEMON_CAPS.filter((cap) => !Array.isArray(caps) || !caps.includes(cap));
  if (missing.length > 0)
    // The DAEMON answered and named its capabilities: this is a measured refusal, not a failed probe.
    return { verdict: "UNSUPPORTED", reason: `the daemon's /api/meta capabilities do not include ${missing.join(" and ")}`, requirement: TELEPTY_DAEMON_REQUIREMENT };
  const where = `GET /api/sessions/${sidPathSegment(sid)}`;
  const s = localGet(target.port, `/api/sessions/${sidPathSegment(sid)}`, token);
  if (s.status === 401 || s.status === 403) return { verdict: "CREDENTIAL_REFUSED", reason: `${where} answered ${s.status}` };
  if (s.status === 404)
    return jsonObject(s.body) !== null
      ? { verdict: "FRESH", reason: `no session '${sid}' on 127.0.0.1:${target.port}` }
      : { verdict: "UNKNOWN", reason: `${where} answered 404 without a JSON body` };
  if (s.status === 200) {
    const rec = jsonObject(s.body);
    if (rec === null) return { verdict: "UNKNOWN", reason: `${where} answered 200 without a JSON object` };
    if (rec.id !== sid || (rec.alias !== undefined && rec.alias !== null))
      return { verdict: "UNKNOWN", reason: `${where} answered for a different id or through an alias` };
    return {
      verdict: "EXISTS_IDENTITY_UNPROVEN",
      reason: `session '${sid}' already exists; this boot cannot prove it is yours, so it is not attached, replaced, killed or deleted`,
    };
  }
  return { verdict: "UNKNOWN", reason: s.status === null ? `${where} gave no complete answer within the bound` : `${where} answered ${s.status}` };
}

/**
 * Every verdict but FRESH: exit 3, an EMPTY stdout (the shim cannot exec), one stderr line.
 * #1293 adds ONE further line, and only when the preflight ESTABLISHED a fact about the telepty CLI
 * or its daemon (`requirement`, which names which of the two). The first line is byte-identical for
 * every verdict, so nothing that reads it changes; an UNSUPPORTED verdict that established nothing
 * still prints exactly the one line it always did.
 */
function refusePreflight(sid: string, p: Preflight): never {
  writeOut(2, `orchestrator-boot.sh: boot preflight ${p.verdict} for '${sid}' — ${p.reason}. Nothing was created, attached, signalled, deleted or exec'd.\n` +
    (p.requirement !== undefined ? `orchestrator-boot.sh: ${p.requirement}\n` : ""));
  process.exit(3);
}

// The exec argv, as data, so a guard can assert its shape without running it.
//
// --auto-restart, MEASURED (cli.js 0.8.0, not inferred): the flag is extracted by
// indexOf over the args after `allow` and spliced out before `command = allowArgs[0]`
// (cli.js:1837-1846), so it must precede the command word — which is also where every
// worker carries it. Its behaviour is referenced at exactly two places, cli.js:2576 and
// :2605, both inside attachChildExitHandler: when the WRAPPED CHILD exits abnormally the
// bridge respawns it with exponential backoff (1s→8s, capped, MAX_CRASHES, counter reset
// after 30s of survival) instead of tearing the session down.
//
// So it is worth having — without it a `claude` crash takes the whole orchestrator
// session with it, and workers have had that protection all along — but it is NOT what
// saved the workers on 2026-08-16, and it would not have prevented that incident. WS
// reconnect and re-register are unconditional and have nothing to do with this flag
// (cli.js:2224-2256, scheduleReconnect, landed 2026-03-14).
//
// THE HARDCODED TAIL IS GONE (#1181 v2). What used to live here was
//
//     claude --dangerously-skip-permissions --continue
//     codex resume --last --dangerously-bypass-approvals-and-sandbox
//
// selected by `ORCHESTRATOR_CLI`. Both lines chose a permission bypass AND a session resume
// from a variable that names neither, on the process that becomes the control tower. There is
// no code path left that can produce them unless an operator names each part and — for the
// bypass — types an acknowledgement for it.
//
// WHAT SURVIVES IS THE HEAD, and it is still FIXED DATA: every plan's argv begins
// `telepty allow-create-v1 --id <sid> --auto-restart` (plan.ts buildExecArgv). Task 1270 changed
// only the verb — `allow` to the versioned create-only `allow-create-v1`, with no fallback — so
// `--auto-restart`'s measured pre-command position and telepty's lifecycle are unchanged. Only the
// tail after `--auto-restart` comes from the plan.

/**
 * Invariant 3 — hand the argv back to the shim, one element per line, and let the
 * SHELL exec it. This process must be gone before the bridge exists.
 *
 * Called ONCE, from one place, and only after the plan is confirmed and the preflight has
 * answered FRESH. A second caller would be a second boot.
 */
function emitExecArgv(argv: readonly string[]): void {
  writeOut(1, `${argv.join("\n")}\n`);
}

// ── the context handoff (task 1201, SPEC §6) ────────────────────────────────
// ONE step, after a FRESH boot preflight (no session holds the chosen id). The
// engine (src/context-handoff, read-only scan of the four CLIs' native transcript stores)
// picks the newest orchestrator session of this workspace, writes
// `<ws>/state/handoff/latest.{md,json}`, and plan.ts handoffArgv adds POINTER-ONLY tokens.
//
// IT NEVER BLOCKS. Every refusal, exception and timeout leaves ref=null, which makes the argv
// byte-identical to the pre-handoff one; the exit code never changes; and the step says what
// happened in fixed-vocabulary lines through log(), so on the boot path nothing reaches fd 1.
//
// The engine is a DYNAMIC import: a missing or broken engine module is `skipped:error`, not an
// ERR_MODULE_NOT_FOUND that stops the boot, and the static boot module closure that
// tests/packaging/native-capture.test.mjs pins is unchanged.
type HandoffEngine = typeof import("../context-handoff/cli.js");
type HandoffResolved = ReturnType<HandoffEngine["resolveHandoff"]>;
const HANDOFF_BUDGET_MS = 2500;
// `auto` (or unset) runs the step; `off` is the opt-out (D-3). Deliberately NOT a PLAN_FIELD:
// it changes no permission, so it must not trigger the plan-field refusal.
const HANDOFF_ENV = env.AIGENTRY_HANDOFF;

interface HandoffStep {
  /** Only a ref that passed handoffRefusal. null = no tokens, argv unchanged. */
  readonly ref: NonNullable<HandoffResolved["ref"]> | null;
  /** The step's stderr lines, unprefixed (log() adds the tag). */
  readonly lines: readonly string[];
  /** The composed handoff, only alongside a ref (dry-run prints it). */
  readonly markdown: string | null;
  /** Why there is no ref, for the review screen. */
  readonly reason: string;
}

function handoffEnabled(): boolean {
  return HANDOFF_ENV === undefined || HANDOFF_ENV === "" || HANDOFF_ENV === "auto";
}

let handoffEngine: Promise<HandoffEngine | null> | undefined;
function loadHandoffEngine(): Promise<HandoffEngine | null> {
  handoffEngine ??= import("../context-handoff/cli.js").then((m: HandoffEngine) => m, () => null);
  return handoffEngine;
}

/** Control characters in an engine-supplied value must not reach the terminal as such. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "?");
}

function handoffSourceKey(ref: NonNullable<HandoffResolved["ref"]> | null): string {
  return ref === null ? "none" : oneLine(`${ref.source.cli}:${ref.source.sessionId.slice(0, 8)} last=${ref.source.lastActivity}`);
}

function handoffSourceId(ref: NonNullable<HandoffResolved["ref"]> | null): string {
  return ref === null ? "none" : `${ref.source.cli}:${ref.source.sessionId}`;
}

/** Synchronous so the wizard's review can call it; `engine` is loaded by the caller. */
function handoffStep(engine: HandoffEngine | null, plan: BootPlan, bootId: string, write: boolean): HandoffStep {
  const lines: string[] = [];
  const none = (outcome: string): HandoffStep => ({ ref: null, lines: [...lines, `handoff: ${outcome}`], markdown: null, reason: outcome });
  if (!handoffEnabled() && HANDOFF_ENV !== "off")
    lines.push(`handoff: AIGENTRY_HANDOFF=${JSON.stringify(HANDOFF_ENV)} is not auto|off — treated as off`);
  if (!handoffEnabled()) return none("off (AIGENTRY_HANDOFF)");
  // D-5: resume with a first-turn prompt is unmeasured, so the handoff rides only on `new`.
  if (plan.history.kind !== "new") return none("skipped — native resume chosen");
  const started = Date.now();
  // The cwd the exec inherits (plan.inheritedCwd). lstat, so a `state` symlink is refused too.
  let workspace: string;
  try {
    workspace = fs.realpathSync.native(process.cwd());
    if (!fs.lstatSync(path.join(workspace, "state")).isDirectory()) return none("skipped:no-state-dir");
  } catch {
    return none("skipped:no-state-dir");
  }
  if (engine === null) return none("skipped:error");
  let r: HandoffResolved;
  const deliveryRecord = handoffDeliveryRecord(plan.provider);
  try {
    // deadlineMs > 1e12 is an absolute epoch-ms deadline in W's contract. The engine never
    // throws by contract; the catch is the boot's own never-block guarantee.
    r = engine.resolveHandoff({
      workspace,
      env,
      now: new Date(),
      bootId,
      write,
      deadlineMs: started + HANDOFF_BUDGET_MS,
      ...(deliveryRecord ? { delivery: deliveryRecord } : {}),
    });
  } catch {
    return none("skipped:error");
  }
  if (Date.now() - started > HANDOFF_BUDGET_MS) return none("skipped:timeout");
  const cap = plan.provider;
  // §6.2: the one file a token may point at. Anything else from the engine is not delivered.
  const expected = path.join(workspace, "state", "handoff", "latest.md");
  const refusal = r.ref === null ? null : r.ref.file !== expected ? "the handoff file is not <ws>/state/handoff/latest.md" : handoffRefusal(r.ref);
  const ref = refusal === null ? r.ref : null;
  const delivery = r.ref === null ? "none" : refusal !== null ? "refused" : handoffDeliveryLabel(cap);
  let line = `handoff: ${r.record.outcome}`;
  if (ref !== null) line += ` source=${ref.source.cli}:${ref.source.sessionId.slice(0, 8)} last=${ref.source.lastActivity}`;
  if (r.record.handoff?.bytes !== undefined) line += ` bytes=${r.record.handoff.bytes}`;
  line += ` delivery=${delivery}`;
  if (r.record.warning) line += ` warning=${r.record.warning}`;
  lines.push(oneLine(line));
  if (refusal !== null) lines.push(`handoff: not delivered — ${refusal}`);
  else if (ref !== null && handoffArgv(cap, ref).length === 0) lines.push(`handoff: ${cap.key} delivery unmeasured — backstop only (AGENTS.md)`);
  return { ref, lines, markdown: ref === null ? null : r.markdown, reason: oneLine(`${r.record.outcome}`) };
}

async function runHandoffStep(plan: BootPlan, bootId: string, write: boolean): Promise<HandoffStep> {
  const engine = handoffEnabled() && plan.history.kind === "new" ? await loadHandoffEngine() : null;
  return handoffStep(engine, plan, bootId, write);
}

function previewOf(step: HandoffStep): HandoffPreview {
  return step.ref === null ? { kind: "none", reason: step.reason } : { kind: "found", ref: step.ref };
}

// The wizard's last review preview, so main() can say when the post-guard selection differs.
let reviewedHandoff: HandoffStep | undefined;

// ── plan resolution ─────────────────────────────────────────────────────────
// What a resolved boot looks like to the rest of this file: the argv to hand back, the
// SELECTED cli (what the capture validator must measure), the sid the preflight must look up,
// the plan itself for the review and the dry-run report, and which door the plan
// came through (#1162: provenance for the display-only boot record, nothing else).
type Resolution = {
  readonly argv: readonly string[];
  readonly cli: string;
  readonly sid: string;
  readonly plan: BootPlan;
  readonly planSource: PlanSource;
};

function resolutionOf(plan: BootPlan, planSource: PlanSource): Resolution {
  return { argv: buildExecArgv(plan, undefined, INPUT_POLICY), cli: plan.provider.key, sid: plan.sid, plan, planSource };
}

/**
 * The ONE refusal every incomplete environment lands on. It names each offending field, prints
 * the usage that documents the schema, and stops — before the capture validation and before
 * the boot preflight.
 */
function refusePlan(errors: readonly { field: string; message: string }[]): never {
  writeOut(2, "orchestrator-boot.sh: refusing to boot — the boot plan is not complete/valid.\n");
  for (const e of errors) writeOut(2, `  ${e.field} ${e.message}\n`);
  writeOut(
    2,
    "There is no fallback. An incomplete plan is never completed with a default permission, a\n" +
      "silent resume, or a hardcoded bypass argv. On a terminal, run a bare " +
      "'bin/orchestrator-boot.sh'\nand choose; to produce this environment from a reviewed " +
      "plan, run '--wizard-plan'.\n",
  );
  writeOut(2, `${USAGE}\n`);
  process.exit(2);
}

/**
 * The non-prompting resolution, used by `--dry-run` and `__probe` — both of which must stay
 * read-only and must never block on a terminal.
 *
 * A complete explicit plan is the ONLY thing it can resolve. Without one it refuses, on a
 * terminal as much as off it: `--dry-run` has to produce the same bytes from a script, a pipe
 * and a prompt, so it cannot be the mode that asks.
 */
function resolveWithoutPrompting(): Resolution {
  if (!PLAN_REQUESTED)
    refusePlan([
      {
        field: PLAN_ENV.enable,
        message:
          "=1 is required, with a complete plan, for any boot that is not an interactive " +
          "wizard on a terminal. ORCHESTRATOR_CLI alone is not authority for a permission " +
          "mode or for resuming a conversation, and there is no longer a default for either",
      },
    ]);
  const result = parseEnvPlan(env, process.cwd());
  if (!result.ok) refusePlan(result.errors);
  return resolutionOf(result.plan, "env-plan");
}

/**
 * The boot path's resolution. A terminal gets the wizard; everything else must have stated a
 * complete plan.
 *
 * CANCELLATION EXITS NON-ZERO WITH AN EMPTY STDOUT, which is the whole of the cancel
 * contract: the shim's `set -e` aborts at the command substitution, its "printed no exec
 * argv" arm is the backstop under that, and no preflight, credential read or provider
 * invocation has happened, because the wizard runs BEFORE all of them.
 */
async function resolveForBoot(): Promise<Resolution> {
  if (!WIZARD_TTY) return resolveWithoutPrompting();
  // Task 1201 §6.3: the review shows a READ-ONLY preview of the handoff source. Reading is not
  // an effect; the post-guard run in main() is the one that writes.
  const engine = handoffEnabled() ? await loadHandoffEngine() : null;
  const handoffPreview = (plan: BootPlan): HandoffPreview => {
    reviewedHandoff = handoffStep(engine, plan, randomUUID(), false);
    return previewOf(reviewedHandoff);
  };
  const outcome = await runWizard({ out: process.stderr, input: process.stdin, env, cwd: process.cwd(), handoffPreview, ...(INPUT_POLICY !== undefined ? { inputPolicy: INPUT_POLICY } : {}) });
  if (outcome.kind === "cancelled") {
    writeOut(2, `[orchestrator-boot] ${outcome.reason} — nothing was listed, deleted, signalled or exec'd.\n`);
    // 1, not 2: this is the operator's own decision, not a refusal of bad input. Either way
    // stdout is empty and the shim cannot exec.
    process.exit(1);
  }
  return resolutionOf(outcome.plan, "wizard");
}

async function validateCapture(cli: string): Promise<void> {
  // The SELECTED cli, not the env's: a plan that chose codex must be measured as codex, and
  // a plan that chose anything else must not be measured as codex just because the
  // environment still mentions it.
  if (cli !== "codex") return;
  try {
    const workspace = path.resolve(SCRIPT_DIR, "..");
    const home = env.AIGENTRY_HOME || path.join(os.homedir(), ".aigentry");
    for (const file of [path.join(workspace, ".aigentry-native-capture.lock"),
      path.join(workspace, ".aigentry-preservation.lock"), path.join(home, ".aigentry-preservation.lock")]) {
      try { fs.lstatSync(file); throw new Error("pending operation"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const stampPath = path.join(workspace, ".aigentry-init.json");
    let stampBytes: Buffer;
    try {
      const st = fs.lstatSync(stampPath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("unsafe stamp");
      stampBytes = fs.readFileSync(stampPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const stamp = JSON.parse(stampBytes.toString("utf8")) as {
      nativeCapture?: { outputs?: Record<string, { hash: string; mode: number; uid: number; gid: number }> };
    };
    if (!stamp.nativeCapture) return;
    if (fs.realpathSync.native(workspace) !== workspace || fs.realpathSync.native(process.cwd()) !== workspace)
      throw new Error("wrong control workspace");
    // Verify both modules BEFORE import: validation cannot safely execute a changed adapter.
    for (const rel of ["bin/init/native-capture.mjs", "bin/init/preservation.mjs"]) {
      const file = path.join(workspace, rel), expected = stamp.nativeCapture.outputs?.[rel];
      if (!expected || fs.realpathSync.native(file) !== file) throw new Error("missing adapter identity");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== expected.mode ||
          st.uid !== expected.uid || st.gid !== expected.gid ||
          createHash("sha256").update(fs.readFileSync(fd)).digest("hex") !== expected.hash)
          throw new Error("adapter changed");
      } finally { fs.closeSync(fd); }
    }
    const adapter = await import(pathToFileURL(path.join(workspace, "bin/init/native-capture.mjs")).href) as {
      validateNativeBoot: (request: { workspace: string; home: string }) =>
        { status: string; source: string; definitionHash: string } | null;
    };
    const status = adapter.validateNativeBoot({ workspace, home });
    if (!status) throw new Error("missing native registration");
    writeOut(2, `[orchestrator-boot] Native capture installed/pending-review: ${status.source}\n` +
      `[orchestrator-boot] UserPromptSubmit SHA-256 ${status.definitionHash}; open /hooks to review. ` +
      "Effective enabled/trust state is unverified; launch does not establish capture readiness.\n");
  } catch {
    writeOut(2, "[orchestrator-boot] Native capture static validation failed; inspect installation/operation before boot.\n");
    process.exit(2);
  }
}

/**
 * THE ORDER IS THE CONTRACT (#1181, task 1270).
 *
 * Plan resolution and the operator's confirmation run BEFORE validateCapture() and before the boot
 * preflight. The preflight then asks its bounded exact-local questions, and every verdict but
 * FRESH stops here with exit 3 and an empty stdout. Only after FRESH: the context handoff (task
 * 1201, never blocking), the display-only boot record and the argv for the shim.
 */
async function main(): Promise<never> {
  const resolved = await resolveForBoot();
  await validateCapture(resolved.cli);
  // Task 1215 (boot42): the wizard waited on a human, so the local configuration may have
  // changed since the pre-effect admission. Re-run the same check after the confirmation and
  // immediately before the preflight.
  if (INPUT_POLICY !== undefined && resolved.planSource === "wizard") refuseUnlessAdmitted("on the post-confirmation recheck");
  // The RESOLVED sid, not the environment's: the wizard may have been given another one. In an
  // explicit plan the two are the same value by construction.
  const preflight = bootPreflight(resolved.sid);
  if (preflight.verdict !== "FRESH") refusePreflight(resolved.sid, preflight);
  log(
    `boot preflight FRESH — ${preflight.reason}; booting with 'telepty ${CREATE_VERB}' ` +
      "(a concurrent create of the same id is refused by the daemon with 409; nothing is retried)",
  );
  // Task 1201 — the context handoff, after the preflight. One boot id is shared by the handoff
  // record (latest.json) and the boot record below.
  const bootId = randomUUID();
  const handoff = await runHandoffStep(resolved.plan, bootId, true);
  for (const line of handoff.lines) log(line);
  // Same session = same cli and session id; its last activity may legitimately have moved.
  if (reviewedHandoff !== undefined && handoffSourceId(reviewedHandoff.ref) !== handoffSourceId(handoff.ref))
    log(`handoff source changed since review: ${handoffSourceKey(handoff.ref)}`);
  const argv = buildExecArgv(resolved.plan, handoff.ref ?? undefined, INPUT_POLICY);
  // #1162 — DISPLAY-ONLY boot record (boot-record.ts), after the preflight and before the argv.
  // Best effort and never authority: it cannot exit, never writes fd 1, makes no host or network
  // call, and changes neither the argv nor the exit code. Its one stderr line is fixed vocabulary.
  let bootRecord: string;
  try {
    const r = writeControllerBootRecord(controllerRecordRoot(env), {
      sid: resolved.sid,
      planSource: resolved.planSource,
      cli: resolved.cli,
      model: resolved.plan.model,
      effort: resolved.plan.effort,
      env,
      bootId,
    });
    bootRecord = `${r.outcome} relation=${r.relation}`;
  } catch {
    bootRecord = "skipped:error relation=none";
  }
  writeOut(2, `[orchestrator-boot] boot record: ${bootRecord}\n`);
  log(`exec ${argv.join(" ")}`);
  emitExecArgv(argv);
  process.exit(0);
}

// ── the no-exec modes (#934) ────────────────────────────────────────────────

function help(): never {
  writeOut(1, `${USAGE}\n`);
  process.exit(0);
}

/**
 * `--dry-run` — main()'s plan, capture validation and handoff preview, acting on nothing.
 *
 * Task 1270: it does NOT run the boot preflight. No `telepty boot-capabilities`, no credential
 * read and no daemon request: it reports the static target check and what would be probed, and
 * says that the exec happens only on a FRESH verdict. It never reports a verdict it did not
 * probe — in particular never FRESH.
 *
 * The exec argv comes last and every element is prefixed. On this path the shim has
 * exec'd node and reads nothing back, so there is no command substitution left to
 * confuse — the prefix is for the human and for any script that grew up reading this
 * output, neither of whom should ever find a bare `telepty` alone on a line here.
 */
async function dryRun(): Promise<never> {
  // VALIDATE ONLY, and never prompt (#1181): a dry run must be runnable from a script, from a
  // pipe and from a terminal with the same bytes, so it resolves the plan the non-interactive
  // way even when a terminal is present — and refuses an incomplete environment exactly as a
  // non-interactive boot would. It says so rather than leaving the operator to wonder why no
  // wizard appeared.
  const resolved = resolveWithoutPrompting();
  // Capture is validated before any report line, as in main() and probe(): a refused dry run
  // leaves stdout empty instead of describing effects it will never reach (#1181).
  await validateCapture(resolved.cli);
  log(`plan source: ${PLAN_ENV.enable}=1 explicit plan (validated; nothing below was acted on)`);
  for (const line of describePlan(resolved.plan, undefined, INPUT_POLICY)) log(`plan  ${line}`);
  for (const line of describeEffects(resolved.plan)) log(`would ${line}`);
  if (WIZARD_TTY)
    log(
      "this terminal WOULD get the interactive wizard on a bare 'bin/orchestrator-boot.sh'; " +
        "--dry-run deliberately does not prompt, so what it reports is the plan this environment states",
    );
  const target = preflightTarget();
  if ("verdict" in target) log(`boot preflight would stop: ${target.verdict} — ${target.reason}`);
  else {
    log(`would run 'telepty boot-capabilities' (the telepty on PATH) and require the sealed ${BOOT_CAPABILITIES_SCHEMA} document — not probed`);
    log(`would GET http://127.0.0.1:${target.port}/api/meta and require ${REQUIRED_DAEMON_CAPS.join(" and ")} — not probed`);
    log(`would GET http://127.0.0.1:${target.port}/api/sessions/${sidPathSegment(resolved.sid)} and boot only on 404 — not probed`);
  }
  log(`the exec below happens only on a FRESH verdict; a dry run probes nothing, so no verdict is reported (not probed)`);
  // Task 1201 §6.3 — the same handoff step with write:false. Nothing is written; the composed
  // handoff is shown under [would-handoff] and its delivery tokens are in the [would-exec] lines.
  const handoff = await runHandoffStep(resolved.plan, randomUUID(), false);
  if (handoff.ref !== null)
    log(oneLine(`handoff source: ${handoff.ref.source.cli} session ${handoff.ref.source.sessionId} · last activity ${handoff.ref.source.lastActivity} · ${handoff.ref.source.path}`));
  for (const line of handoff.lines) log(line);
  if (handoff.markdown !== null) for (const line of handoff.markdown.replace(/\n$/, "").split("\n")) writeOut(1, `[would-handoff] ${line}\n`);
  const argv = buildExecArgv(resolved.plan, handoff.ref ?? undefined, INPUT_POLICY);
  log(`would exec ${argv.join(" ")} (one element per line below)`);
  for (const a of argv) writeOut(1, `[would-exec] ${a}\n`);
  process.exit(0);
}

/**
 * `--wizard-plan` (#1181) — COLLECT A PLAN, PRINT IT, ACT ON NOTHING.
 *
 * This is how an automated caller gets a correct `AIGENTRY_BOOT_PLAN=1` environment without
 * anyone hand-writing one: a human runs the wizard once, copies the lines, and the plan they
 * reviewed is the plan the script will carry. It cannot boot — it has a non-empty argv, so
 * the shim exec'd node and there is no command substitution left to read it — and it never
 * runs the preflight and never resolves a credential.
 */
async function wizardPlan(): Promise<never> {
  if (!WIZARD_TTY) {
    writeOut(2, "orchestrator-boot.sh: --wizard-plan needs a terminal on stdin and stderr; there is nothing to collect a plan from here\n");
    process.exit(2);
  }
  const outcome = await runWizard({ out: process.stderr, input: process.stdin, env, cwd: process.cwd() });
  if (outcome.kind === "cancelled") {
    writeOut(2, `[orchestrator-boot] ${outcome.reason} — no plan was printed and nothing was acted on.\n`);
    process.exit(1);
  }
  // fd 1 here carries the PLAN, not an argv: this mode is unreachable from the boot path's
  // command substitution, and every line is a NAME=value pair rather than a bare token.
  //
  // This loop is the ONLY write to fd 1 anywhere on this mode's paths, and it runs only after
  // a confirmed plan exists. `LOG_FD` is fd 2 here (see its definition), so the note below,
  // the no-terminal refusal, the cancellation notice and the D1 refusal all leave stdout
  // empty. An fd-1 I/O failure inside this loop can still leave a partial capture.
  for (const line of planEnvLines(outcome.plan)) writeOut(1, `${line}\n`);
  log("plan printed; nothing was reconciled, signalled, deleted or exec'd. Set these in the caller's environment.");
  process.exit(0);
}

function unknownFlag(): never {
  // Before #934 this arm did not exist: `orchestrator-boot.sh --bogus-flag` ran the
  // full boot and exited 0. Exit 2 is the code this file already uses for "refusing
  // to boot" (D1 above, and the shim's own empty-argv refusal).
  // stderr for both, unlike --help/--dry-run: this is a diagnostic about a failed
  // invocation, not the output the caller asked for, so `… --bogus > out` must leave
  // `out` empty rather than looking like it produced something.
  writeOut(2, `orchestrator-boot.sh: unknown argument: ${CLI_ARGV.join(" ")}\n`);
  writeOut(2, `${USAGE}\n`);
  process.exit(2);
}

// ── __probe: the internal inspection seam ───────────────────────────────────
// Task 1270 REMOVED `singleton-guard` and `registry-reconcile` together with the SIGKILL guard
// and the DELETE reconcile they inspected; both names now land on the unknown-subcommand arm.
// What remains is `exec-argv`: it prints the argv a FRESH boot would hand back and acts on
// nothing (no preflight, no credential, no request). Internal surface: not a flag, not
// documented, no caller outside tests. The shim routes `__probe` straight to node so a probe
// can never reach the exec.
async function probe(argv: string[]): Promise<never> {
  // The probe resolves the plan the non-prompting way, so an inspection can never block on a
  // terminal and can never be the thing that asks a human to authorise an elevated boot.
  const resolved = resolveWithoutPrompting();
  await validateCapture(resolved.cli);
  const sub = argv[0];
  if (sub === "exec-argv") {
    emitExecArgv(resolved.argv);
    process.exit(0);
  }
  fs.writeSync(2, `orchestrator-boot.sh: unknown __probe subcommand: ${String(sub)}\n`);
  process.exit(4);
}

// The boot path takes no argument and never has: bash's `main "$@"` used no positional
// parameter, so `orchestrator-boot.sh anything` booted. #934 ENDS THAT — booting now
// requires an EMPTY argv, and every other shape lands somewhere that cannot exec. The
// shim enforces the same rule one layer up (it execs node for any non-empty argv), so
// the two halves agree even if this file is run directly.
switch (MODE) {
  case "probe":
    await probe(CLI_ARGV.slice(1));
    break;
  case "help":
    help();
    break;
  case "dry-run":
    await dryRun();
    break;
  case "wizard-plan":
    await wizardPlan();
    break;
  case "unknown":
    unknownFlag();
    break;
  default:
    await main();
}
