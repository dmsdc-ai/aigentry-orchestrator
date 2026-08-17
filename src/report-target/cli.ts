// orchestrator-report-target — resolve the worker→orchestrator REPORT/HOLD target
// for #690 (Rule 16: no hardcoded session id / IP), ported from
// bin/orchestrator-report-target.sh by #899 tranche 5 (rt899).
//
// Disposition: docs/reports/2026-08-18-899-t5-report-target-disposition.md
//              (every measurement cited below, taken against the original bash at
//              b300875)
//
// Prints ONE line on stdout: the address a dispatched worker should
// `telepty inject` its REPORT/HOLD to.
//
//   <sid>@<tailnet-ip>   when a Tailscale CGNAT (100.64.0.0/10) address is found
//                        AND the daemon actually answers there — resolves from
//                        both local and cross-machine workers.
//   <sid>                bare fallback (single-machine / no tailnet / nothing
//                        listening on the tailnet address) — resolves locally.
//
// ⚠️ WHY A WRONG ANSWER HERE IS EXPENSIVE. src/dispatch/cli.ts:595-597 is the only
// production caller: it substitutes this stdout into {{ORCHESTRATOR_REPORT_TARGET}}
// in EVERY worker's dispatch ref, and it reads STDOUT ONLY, so the notes below never
// reach a ref. It requires rc 0 AND non-empty stdout and otherwise refuses the
// dispatch (fail-closed, #690). Two consequences this file must never break:
// **the exit code is 0 on every path** — there is no error arm, and adding one would
// block every dispatch that took it — and **stdout is exactly one line with no
// spaces**, which tests/dispatch/T92 case 8 pins.
//
// THE BEHAVIOUR IS UNCHANGED. Every arm, both output streams, all five env seams,
// the curl argv, the interface-scan argv and the CGNAT regex are byte-identical to
// the bash at b300875. tests/dispatch/T129 is a characterization guard that passes
// against BOTH implementations, so there is no `REPORT_TARGET_PARITY_ORIGINAL` flag
// — nothing diverges for one to select. T67 and T92 are untouched and still pass.
//
// THE DESIGN NOTES OF THE BASH ARE ITS OWN and stay in bin/orchestrator-report-
// target.sh's header (why the probe exists at all, why an explicit host is honoured
// loudly, why cannot-probe is not unreachable, the cost ceiling, the cross-machine
// gap). They are the operator-facing rationale, not a description of this code, so
// they are not duplicated here. What follows is only what the PORT decided.
//
// WHAT CHANGED, and what was measured for it (Rule 38).
//
//   * `grep -Eo` / `head -n1` / `command -v` are in-process now. They were how bash
//     reached a regex and a PATH lookup, never a contract. The regex itself is
//     copied character for character, including its lack of boundary anchors (D1).
//     POSIX ERE is leftmost-LONGEST and JS is leftmost-first-alternative, so that
//     substitution is only safe because the four second-octet alternatives are
//     mutually exclusive at any given position — checked digit by digit
//     (`6[4-9]`, `[7-9][0-9]`, `1[01][0-9]`, `12[0-7]` cannot both match the same
//     start), and the two `[0-9]{1,3}` octets are greedy in both engines.
//
//   * THE `command -v` GATE BECOMES A SPAWN-ERROR GATE (D5 in the disposition, the
//     one deviation, and it is not observable). bash gated the probe on
//     `command -v "$CURL"` and printed `unknown` WITHOUT attempting an exec;
//     `probeHost` below attempts the exec and maps any spawn error to the same
//     `unknown`. Measured that the two gates agree on both interesting inputs: a
//     path that does not exist (ENOENT) and a path that exists but is not
//     executable (EACCES) — bash's `command -v` reports NOT FOUND for the latter
//     too, which is easy to assume wrong. The port attempts an exec that bash did
//     not; it produces no output, no side effect and no probe-log entry, so no
//     guard and no caller can tell. Reproducing `command -v`'s PATH walk by hand
//     would be more code for a distinction nothing can observe.
//
// FOUR LATENT DEFECTS ARE REPRODUCED, NOT FIXED, on the orchestrator's GO. All four
// were measured against the original bash; the reproductions are in the disposition
// §7 and the report §5.
//
//   D1 THE CGNAT REGEX IS UNANCHORED, so a longer digit run can synthesise an
//      address that is on no interface: a scan line `inet6 fe80::9100.72.1.1234`
//      yields `100.72.1.123`. Self-limiting in the auto path, because the probe
//      then says `silent` and it falls back to the bare sid — it only bites if the
//      synthesised address happens to answer on 3848. Not data-loss, and the input
//      is this machine's own `ifconfig`, so not a trust boundary.
//   D2 A NEWLINE IN EITHER OVERRIDE MAKES STDOUT MULTI-LINE, and the extra line
//      lands in every worker's ref: `AIGENTRY_ORCHESTRATOR_HOST=$'1.2.3.4\nEVIL'`
//      prints two lines, and src/dispatch/cli.ts:597 strips TRAILING newlines only
//      (`replace(/\n+$/,"")`), so an embedded one survives the substitution.
//      Reproduced. Deliberately not refused: `AIGENTRY_ORCHESTRATOR_SID` and
//      `AIGENTRY_ORCHESTRATOR_HOST` are operator-only — grepped the whole tree,
//      NOTHING in bin/, src/, tests/ or launchd sets either — so this is not a
//      trust boundary, and silently rewriting an operator's stated value would
//      contradict the honour-it-loudly posture T92 case 3 protects.
//   D3 THE INTERFACE SEAM CANNOT CARRY ARGUMENTS. bash ran `"$IFACE_CMD"` as one
//      quoted word, so a value with a space is looked up as a single filename and
//      fails, leaving an empty scan and the bare sid. Reproduced EXACTLY, and it is
//      the reason `spawnSync` below passes an empty argv and never `shell: true`:
//      splitting the value on spaces, or handing it to a shell, would ADD an
//      argument- and command-injection surface to a seam that has none today.
//   D4 THE NOTES REACH NOBODY IN PRODUCTION. `capture()` at src/dispatch/cli.ts:54
//      uses spawnSync's defaults, so this process's stderr is piped into a string
//      that is never read — the "cross-machine workers have no working report
//      target" warning that #835 and T92 case 2 exist to produce is discarded by
//      the only caller that would act on it. The fix belongs in src/dispatch/cli.ts
//      (the `captureOut` helper at :64 already inherits stderr), which is outside
//      this task's Rule 29 scope; filed as a ticket with the exact diff in the
//      report §6 rather than fixed here.
//
// Article 17 (무의존): node stdlib only. `curl` and the interface listers stay
// subprocesses with IDENTICAL argv.
//
// `os.networkInterfaces()` IS DELIBERATELY NOT USED, though it would be less code.
// `REPORT_TARGET_IFACE_CMD` must keep accepting an arbitrary executable whose STDOUT
// IS PARSED — that is the only way T92 pins address selection hermetically. Using
// the native lister for the default path while the seam path parsed text would give
// this file TWO selection algorithms, and every guard would exercise the one
// production never runs. One algorithm, text in, first CGNAT match out; the seam
// substitutes the SOURCE of that text, exactly as bash does.
//
// Rule 26: ZERO platform branches. Enumerated on the bash —
// `grep -nE 'uname|OSTYPE|Darwin|Linux|sw_vers'` matches nothing. The only
// OS-adaptivity is running BOTH listers and letting the absent one contribute
// nothing, which is not a branch and is reproduced as such below.
import { spawnSync } from "node:child_process";

const env = process.env;

// `$CURL` is the seam src/tracker/cli.ts:56 uses under the same name.
// REPORT_TARGET_IFACE_CMD is the interface-scan seam: it is the one input a test
// cannot pin through the public overrides, because setting
// AIGENTRY_ORCHESTRATOR_HOST also selects the explicit branch.
const CURL = env.CURL || "curl";
const IFACE_CMD = env.REPORT_TARGET_IFACE_CMD || "";

// `||` and not `??`: bash's `${TELEPTY_PORT:-3848}` falls back on an EMPTY value as
// well as an unset one, and it is read here rather than at each use so the URL and
// both note texts can never disagree about the port. Measured both spellings.
const PORT = env.TELEPTY_PORT || "3848";

function note(msg: string): void {
  process.stderr.write(`orchestrator-report-target: ${msg}\n`);
}

/** `$(cmd)` — command substitution strips TRAILING newlines and nothing else. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/**
 * `cmd 2>/dev/null || true` — stdout only; a failure, a missing binary and a
 * non-executable one all contribute the empty string, exactly as the redirect and
 * the `|| true` did. Argv is always empty or fixed: never `shell: true` (D3).
 */
function scanOut(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) return "";
  return r.stdout || "";
}

type Probe = "answered" | "silent" | "unknown";

/**
 * probe_host <host> → answered | silent | unknown
 *   answered — the daemon responded there (any HTTP status)
 *   silent   — the exchange completed without a response: nothing is listening
 *   unknown  — we could not measure at all; NOT a negative result
 *
 * NOTE the missing `|| echo 000` in the bash this replaces, and why it stays missing
 * here: with `-w '%{http_code}'` curl prints `000` on a connect failure AND exits
 * non-zero, so the usual `$(curl … || echo 000)` idiom concatenates both into
 * `000000` — which matches no arm and falls through as if the host had answered.
 * The equivalent mistake in this file would be defaulting the status on a non-zero
 * `r.status`; instead curl's own stdout is the only source of truth, and only a
 * SPAWN error (curl never ran at all) becomes `unknown`.
 */
function probeHost(h: string): Probe {
  const r = spawnSync(
    CURL,
    [
      "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "--connect-timeout", "1", "--max-time", "2",
      `http://${h}:${PORT}/api/meta`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.error) return "unknown"; // ENOENT or EACCES — bash's `command -v` gate
  const http = chomp(r.stdout || "");
  return http === "" || http === "000" ? "silent" : "answered";
}

/**
 * CGNAT 100.64.0.0/10 → second octet 64-127. With the seam unset, scan BOTH
 * `ifconfig` (macOS/BSD) and `ip` (Linux); whichever exists produces output, the
 * other is silently empty. Both run unconditionally and in that order, and one
 * failing does not stop the other — in the bash the whole group was the left operand
 * of `|| true`, which suppresses `set -e` inside it (measured, because the opposite
 * reading is the plausible one).
 */
const CGNAT = /100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}/;

function detectHost(): string {
  const scan = IFACE_CMD
    ? scanOut(IFACE_CMD, [])
    : scanOut("ifconfig", []) + scanOut("ip", ["-o", "-4", "addr", "show"]);
  const m = scan.match(CGNAT); // `grep -Eo … | head -n1` — first match wins
  return m ? m[0] : "";
}

function main(): void {
  const sid = env.AIGENTRY_ORCHESTRATOR_SID || "orchestrator";

  // `${AIGENTRY_ORCHESTRATOR_HOST:-}` — an EMPTY explicit host selects auto-detect,
  // not the explicit branch. Measured; `||` reproduces it.
  const explicit = Boolean(env.AIGENTRY_ORCHESTRATOR_HOST);
  const host = explicit ? String(env.AIGENTRY_ORCHESTRATOR_HOST) : detectHost();

  // No candidate at all — single-machine. Nothing to measure, nothing to claim, and
  // NO probe is issued: T92 case 6 pins that, because every dispatch would pay for it.
  if (!host) {
    process.stdout.write(`${sid}\n`);
    return;
  }

  switch (probeHost(host)) {
    case "answered":
      process.stdout.write(`${sid}@${host}\n`);
      return;
    case "silent":
      if (explicit) {
        note(
          `AIGENTRY_ORCHESTRATOR_HOST=${host} does not answer on port ${PORT}; honouring it because you set it explicitly, but reports sent there will go nowhere until the daemon listens on it.`,
        );
        process.stdout.write(`${sid}@${host}\n`);
      } else {
        note(
          `auto-detected tailnet address ${host} does not answer on port ${PORT} — falling back to the bare '${sid}', which resolves locally. Cross-machine workers have no working report target while that listener is down.`,
        );
        process.stdout.write(`${sid}\n`);
      }
      return;
    case "unknown":
      note(
        `cannot probe ${host} (no '${CURL}' available) — keeping the tailnet form unverified; an absent measurement is not a negative one.`,
      );
      process.stdout.write(`${sid}@${host}\n`);
      return;
  }
}

main();
