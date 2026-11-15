// The `--help` text for bin/orchestrator-boot.sh (#934). NEW SURFACE, not a port:
// there was no `--help` here and never had been, which is the whole of #934.
//
// It lives in its own module for the reason every other tool in this repo does it —
// src/dispatch/usage.ts, src/tracker/usage.ts, src/cleanup/usage.ts,
// src/reconciler/usage.ts, src/hitl/usage.ts, src/session/open-session/usage.ts,
// src/bus-bridge/usage.ts and src/bridge-auditor/usage.ts — the shim is an exec
// wrapper with no comment header for a `sed -n '30,40p' "$0"` arm to slice, so a
// usage that lived in the shell would print nothing at all.
//
// TWO THINGS THIS TEXT MUST KEEP DOING, both of them the incident of 2026-08-18:
//
//   1. SAY THAT A BARE INVOCATION ACTS. The orchestrator ran
//      `bin/orchestrator-boot.sh --help | head -2` as a smoke check and got the real
//      boot — at the time reconcile, SIGKILL guard and exec (both removed by task 1270) —
//      because argv was not read at all. A usage that documents the flags and stays quiet
//      about what happens with NO flag would leave that reading of the script intact.
//   2. NAME EVERY SEAM. src/bridge-auditor/usage.ts:18-21 records what the other
//      failure looks like: a hardcoded `sed` range that drifted one line short, so
//      its `--help` advertised SINGLETON_PS_CMD and hid TELEPTY. tests/dispatch/T134
//      block B reads the seam list back out of the COMPILED implementation and fails
//      if a seam is added here without a line below, so that cannot happen twice.
export const USAGE = `orchestrator-boot.sh — boot the orchestrator (control tower) bridge (#539, #905).

Usage:
  bin/orchestrator-boot.sh              BOOTS. With no flag this script ACTS: after the
                                        boot preflight below answers FRESH it REPLACES
                                        this shell with 'telepty allow-create-v1' — a
                                        bare invocation is not an inspection. It never
                                        lists, kills or deletes an existing session.
  bin/orchestrator-boot.sh --help, -h   this text on stdout; exit 0. Nothing is
                                        listed, killed, deleted or exec'd.
  bin/orchestrator-boot.sh --dry-run    validate and describe only: the plan, the static
                                        target check, what the preflight WOULD probe (it
                                        probes nothing: no telepty, credential or daemon
                                        request, so it reports no verdict), and the argv a
                                        FRESH verdict WOULD exec. exit 0. No exec.
  bin/orchestrator-boot.sh --wizard-plan
                                        run the wizard and print the AIGENTRY_BOOT_PLAN
                                        environment it produces on stdout, for a
                                        non-interactive caller to reuse. Needs a terminal.
                                        UNLIKE --help and --dry-run, THIS mode's stdout is
                                        NAME=value assignments and NOTHING else on success,
                                        and EMPTY on every refusal and cancellation: the
                                        wizard screens, the closing note and every diagnostic
                                        (a bad sid included) are on stderr. So capture stdout,
                                        CHECK THE EXIT CODE, then read the assignments before
                                        using them — exit 0 with a non-empty capture is the
                                        only case that carries a plan. exit 0 on success,
                                        non-zero with an empty stdout otherwise. Nothing is
                                        listed, killed, deleted or exec'd — a non-empty argv
                                        can never boot.
  bin/orchestrator-boot.sh __probe exec-argv
                                        internal: print the argv a FRESH boot would hand
                                        back; no preflight, no request, no exec.

Booting requires an EMPTY argv. Any argument at all — a flag, a typo, anything —
takes a non-booting path, so inspecting this script cannot start a control tower.

WITH NO FLAG THIS SCRIPT ACTS — but only on choices it has been given. On a terminal it
ASKS (the wizard, below). With no terminal it requires a complete explicit plan and
refuses with exit 2 otherwise: no provider default, no permission default, no implicit
resume. Nothing is probed or exec'd on the way to that refusal.

THE BOOT PREFLIGHT (task 1270). After the plan is confirmed and capture is validated, and
before anything is written or exec'd, a boot asks three bounded, exact-local questions:
  1. TELEPTY_HOST unset or exactly 127.0.0.1, and TELEPTY_PORT a port number — otherwise
     TARGET_REFUSED, before any process or request (no alias, peer, host:port or scheme).
  2. 'telepty boot-capabilities' (the telepty on PATH) prints exactly the one-line
     telepty-boot-capabilities-v1 JSON with allow-create-v1 and nondeleting-v1; an older
     telepty's help + exit 0, empty output or any other document is UNSUPPORTED.
  3. GET /api/meta on 127.0.0.1 advertises wrapped-sessions and register-create-only, and
     GET /api/sessions/<sid> answers 404 (FRESH). 401/403 is CREDENTIAL_REFUSED; an existing
     session with exactly that id is EXISTS_IDENTITY_UNPROVEN; an alias, another id, a
     non-JSON body, a timeout or any other answer is UNKNOWN.
Only FRESH boots, with 'telepty allow-create-v1': a concurrent create of the same id is then
refused by the daemon (409) and starts no second application. Every other verdict exits 3
with an EMPTY stdout: nothing is created, attached, signalled, deleted or exec'd, and an
existing session is never killed, replaced or attached by name, command, cwd or pid.

THE WIZARD (#1181). With an empty argv AND a terminal on stdin and stderr, a bare
invocation asks before it acts: provider, model, effort, the chosen provider's own
approval and sandbox axes, history (new by default; resume is explicit), the session
id, then a full review that must be answered with a typed YES — the whole word, in ANY
CASE: 'YES', 'yes', 'Yes' and 'yEs' all confirm, while 'y' alone, 'ye', 'YES!', 'yes
please' and any other trailing text do not. The default answer is
no. 'b' goes back a step; 'q', Ctrl-C and EOF cancel with a non-zero exit, an EMPTY
stdout and no preflight, no daemon request, no credential read and no provider
invocation of any kind. The wizard draws on stderr and reads stdin, because stdout is
the shell's command-substitution channel for the exec argv.
Per-provider options, their accepted values and the version each was measured at come
from a frozen capability registry: this script never runs a provider's own --help to
describe it (measured 2026-09, gemini/grok/codex --help all WRITE to the real HOME).
An unavailable provider is reported as unavailable; nothing is auto-installed and no
provider is ever substituted for another. Similarly named flags on different providers
are NOT treated as the same policy. Any elevated or bypass value needs an extra typed
acknowledgement and is never pre-selected. Native resume is not a context handoff.
The inherited cwd is displayed, never changed: this process runs inside a command
substitution and cannot move the parent shell, and no provider cwd flag is passed.

Run from this repo root: exec inherits cwd; Codex reads AGENTS.md here (CLAUDE.md is a stub).

Capture-configured Codex boot validates installed package measurements, private roots,
registration and operation state before the boot preflight. Failure exits
2 without executable argv. Dry-run and probes perform the same read-only validation.
After static checks, normal interactive launch remains available for /hooks review.
Capture is installed/pending-review; current enabled/trust state remains unverified.
File hashes and old receipts do not establish readiness or authenticated release origin.
Native Windows, other caller paths and timeout/kill admission guarantees remain open.

Env:
  ORCHESTRATOR_CLI          the registered provider executable a plan names: claude, codex,
                            gemini or grok. It is one FIELD OF A PLAN and nothing more — on
                            its own it is not authority for a permission mode or for
                            resuming a conversation, and it no longer selects any argv.
                            Unknown values are refused with exit 2 and usage (except
                            --help). On a terminal it is only a displayed hint: the wizard's
                            list is what selects, and env values never confirm anything.

  The explicit boot plan (#1181). A caller with no terminal cannot be prompted, so it states
  its choices and they are validated before ANY effect. THIS IS THE ONLY WAY TO BOOT WITHOUT
  A TERMINAL: there is no default provider, no default permission mode and no implicit
  resume, and the pre-#1181 hardcoded tails (claude --dangerously-skip-permissions
  --continue, codex resume --last --dangerously-bypass-approvals-and-sandbox) have been
  REMOVED — no path can produce them unless an operator names each part and acknowledges the
  bypass. Every field below is refused if it contains NUL, a newline, a control character or
  a leading '-'. A missing required field is exit 2 with the field named, before the capture
  validation and the boot preflight.
  AIGENTRY_BOOT_PLAN        '1' opts in. Any other non-empty value is refused. Setting
                            any AIGENTRY_BOOT_* field below WITHOUT it is also refused,
                            so an explicit plan can never be silently ignored.
  AIGENTRY_BOOT_MODEL       optional: a validated model identifier, or leave unset for
                            the provider's own default. No model catalogue is pinned in
                            this script, and nothing here can promise your account may
                            use what you name — the provider answers that at boot.
  AIGENTRY_BOOT_EFFORT      optional: only where the capability registry has evidence.
                            claude 2.1.283: --effort low|medium|high|xhigh|max.
                            grok 1.0.25: --reasoning-effort exists but its value set is
                            NOT printed by --help, so one bounded literal is accepted and
                            carried with an unverified-value warning.
                            codex 0.157.1: no effort flag; the config-key route is a
                            RECORDED GAP and setting this field is refused rather than
                            guessed. gemini 0.53.0: measured absent, likewise refused.
  AIGENTRY_BOOT_PERMISSION  required: semicolon-separated axis=value pairs, one entry for
                            each axis the chosen provider HAS, e.g.
                            'approval=on-request;sandbox=read-only' for codex or
                            'approval=manual' for claude (claude 2.1.283 has NO --sandbox
                            flag; it is not given one here). Semicolons, not commas, and
                            no aliases. Each provider's values are its own: claude and
                            grok both spell --permission-mode and are NOT the same policy.
  AIGENTRY_BOOT_HISTORY     required: new | last | selected=<selector>. A new conversation
                            is the default only when you say so. The selector must match
                            the provider's measured form (claude: a session UUID; codex: a
                            UUID or session name; gemini: 'latest' or an index; grok: a
                            UUID or a title for this directory) and may not look like a
                            path. Native resume stays inside the provider's own cwd and
                            configuration — no --all, no cross-provider continuity, no
                            external transcript, and no history listing is ever read.
  AIGENTRY_BOOT_RISK_ACK    required only when the plan selects an elevated or bypass
                            value: the exact phrase the refusal prints, which restates the
                            selection so it cannot keep authorising a later, different one.
  ORCHESTRATOR_SID          the orchestrator session id — same source as
                            bin/dispatch-tracker.sh (Rule 16, no hardcode). REQUIRED in a
                            plan, explicitly; on a terminal it pre-fills a prompt the
                            operator still answers, and the wizard may be given another
                            value, in which case the preflight looks up THAT one
                            (default shown in the prompt: orchestrator).
                            A control character in it is refused (exit 2) on every
                            path but --help: the exec argv crosses back to the shim
                            as text and could not survive the round trip.
  AIGENTRY_HANDOFF          auto (default, also when unset) | off. With auto and a NEW
                            conversation, the boot reads the claude/codex/gemini/grok
                            transcript stores read-only after a FRESH preflight, picks
                            this workspace's newest orchestrator session, writes
                            state/handoff/latest.md (+ latest.json) and passes only a
                            pointer to that file to providers whose delivery is measured.
                            off skips it and leaves the argv unchanged; any other value
                            warns and is treated as off. Not a plan field. --dry-run shows
                            the handoff under [would-handoff] and writes nothing.
  TELEPTY_SUPERVISION_CLIENT_FILE
                            optional: when non-empty, the bridge is booted with the fixed
                            telepty allow-create-v1 flag '--input-policy user-supervised' (right after
                            --auto-restart, never in the provider's arguments); unset or
                            empty leaves the argv exactly as before and runs no check. Not
                            a plan field and not printed by --wizard-plan. When it is set,
                            the boot, --dry-run and __probe refuse with exit 2 a relative
                            path or one with a control character, and otherwise run
                            'telepty allow-check --input-policy user-supervised' — the
                            telepty on PATH that would be exec'd, with this environment,
                            10 s bound — BEFORE the wizard and the boot preflight; a
                            wizard boot runs it again after YES. Anything but a
                            one-line telepty.allow-admission/v1 success (ok, user-supervised,
                            supervision_client loaded) exits 2 with telepty's message,
                            including an older telepty without allow-check. That admits the
                            LOCAL configuration only: it does not prove daemon trust, network
                            liveness or a grant. --dry-run and the wizard review show the flag.
  TELEPTY_HOST              must be unset or exactly 127.0.0.1; anything else is refused
                            (TARGET_REFUSED) before any request. The bridge and
                            'telepty boot-capabilities' are run from PATH, unpinned.
  CURL                      http client for the preflight's two bounded local GETs
                            (/api/meta, /api/sessions/<sid>; default: curl). No DELETE.
  TELEPTY_PORT              telepty daemon port (default: 3848); digits only, 1-65535.
  AIGENTRY_SHIM_SCRIPT_DIR  bin/ directory, exported by the shim so a symlinked
                            entrypoint still locates bin/lib/telepty-auth.sh.
  AIGENTRY_HOME             capture installation's home root (default: ~/.aigentry).
  DISPATCH_STATE_DIR        optional cleanup scheduler state root; capture and backup
                            roots must remain disjoint from it.

Boot the orchestrator via THIS script, not a bare 'telepty allow' or 'telepty allow-create-v1'. Worker sessions
boot via bin/session-start.sh. See AGENTS.md.`;
