// Generated from bin/dispatch.sh lines 2-41 by the #899 tranche-1 port.
//
// The shell `usage()` was `sed -n '2,41p' "$0"` — it printed dispatch.sh's own
// comment header. bin/dispatch.sh is now a 4-line exec shim with no header to
// print, so the text lives here verbatim instead. T60 asserts --help still
// documents AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS and its 180000 default; the
// port pins the whole block byte-for-byte against the pre-port output (see
// tests/dispatch/T99_dispatch_ts_parity.sh).
export const USAGE = `# dispatch.sh — Wraps \`telepty inject\` with REPL-ready wait so the first
#               dispatch to a freshly-spawned session is not lost to the
#               welcome-bootstrap race. Orchestrator-side workaround for
#               telepty#18 (https://github.com/dmsdc-ai/aigentry-telepty/issues/18).
#               헌법 Rule 32 영구 fix mandate (codified 2026-05-12 after 5+ recurrences,
#               until telepty-side handshake / wait-ready / queue lands).
#
# Modes:
#   dispatch.sh --target <sid> --ref <file> [--from <orch-sid>] [--timeout-ms 30000]
#               [--retry-unknown "<reason>"]
#   dispatch.sh --spawn-and-dispatch --track T --name N --cwd P --cli claude \\
#               --ref <file> [--from <orch-sid>] [--role coder|architect|...] [--task-class C] [--worktree P]
#   dispatch.sh --help
#
# Rule 34 task-gate (#736): every dispatch must name the task it actuates.
#   --task <id>           id from state/task-queue.json; status must be one of
#                         pending|queued|in_progress|delegated|blocked-by-observation.
#                         A confirmed dispatch auto-ledgers it (→ delegated + note).
#   --no-task "<reason>"  audited exemption (NDJSON line to
#                         ~/.aigentry/telemetry/dispatch-notask-<UTC-date>.ndjson).
#   AIGENTRY_TASK_GATE=hard|warn|off (default hard) — warn audits+proceeds, off = legacy.
#   AIGENTRY_TASK_QUEUE=<path> overrides the queue (default <repo>/state/task-queue.json).
#
# --cli defaults to auto (the profile's role table; the ref is never sent to a classifier, #1206);
#   explicit CLI bypasses routing.
#   --task-class C  (auto only) picks the profile's role.C row (e.g. coder + integration),
#                   else the role row; C must match ^[a-z][a-z0-9-]{0,31}$ (else exit 4).
#   Routed candidates are tried in order; one at its AIGENTRY_CLI_CAP_<CLI>, with no
#   executable on PATH or no credential file is skipped (stat only); none left exits 78
#   (ROUTE_CANDIDATES_EXHAUSTED), never an unconfined fallback.
# --role (cli=claude|codex|gemini|grok, #431 / #532 / #1083): wires boot-prepare.mjs so the
#   wrapped CLI skips project context-file auto-discovery (the cwd→role
#   contamination exposed by the 2026-05-23 incident). claude uses
#   \`--append-system-prompt-file\`; codex/gemini use the additive path (staged cwd
#   AGENTS.md/GEMINI.md + CODEX_HOME/GEMINI_CLI_HOME shadow home). Omit --role to
#   use the legacy spawn (back-compat).
#
# Spawn decision (#1148): every fresh confined claude|codex spawn, explicit --cli
#   included, resolves ONE model/effort/executable decision (model-router.mjs
#   --resolve): no classifier or model call, never --version/--help; one bounded
#   public docs GET (AIGENTRY_MODEL_METADATA=off skips it; the decision is then
#   labelled degraded, never current). AIGENTRY_<CLI>_EFFORT, _EXECUTABLE and
#   _EXECUTABLE_VERSION (and _MODEL with an explicit --cli) are explicit requests,
#   never substituted. Before any spawn: exit 4 MODEL_TUPLE_INCOMPATIBLE, exit 10
#   MODEL_NO_ELIGIBLE_TUPLE. Existing-target, dedup and retry never re-resolve.
#   --observe <file>  (at most 4) operator negative observation, e.g. a recorded
#                     launch failure; read for this dispatch only, never stored.
#
# Declared worker inputs (#1172), optional, all three or none (else exit 4):
#   --input-root DIR --input-manifest FILE --input-sha256 HASH
#   runs \`bin/worker-inputs.mjs verify\` on a snapshot made by its \`stage\` command
#   before routing, spawn, inject or any ledger/tracker write; a failed verify
#   exits 4 (WORKER_INPUTS_UNVERIFIED) with nothing dispatched. It checks the
#   declared files only, at that moment; it grants and restricts nothing.
#   Omitted, dispatch behaves exactly as before. See docs/setup/dispatch-capacity.md.
#
# Registration wait (#727): a freshly spawned worker needs tens of seconds to
#   appear in \`telepty list\` (workspace boot → CLI boot → bridge registration).
#   The spawn path polls every 5s up to AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS
#   (default 180000) before giving up with exit 6, so a slow spawn stays on the
#   gated path instead of being hand-recovered with a raw \`telepty inject\`
#   (which bypasses the task-gate ledger, delivery confirm and tracker register).
#   --target keeps the historical fail-fast; set the knob to make it wait too.
#   A telepty command that cannot be STARTED (ENOENT: no such file, EACCES: not
#   executable) is not a slow spawn (#1293): the first listing of the wait
#   already proves it, so dispatch refuses there and then with exit 78
#   (TELEPTY_CLI_UNAVAILABLE) instead of spending the whole budget and blaming
#   the knob. A TELEPTY override that fails is named, with the instruction to
#   correct or unset it; install advice is given only when PATH holds no
#   telepty. A telepty that starts but does not list the session (not there
#   yet, or a listing that overflowed its buffer) still waits for the knob and
#   exits 6 at its deadline. Bound delivery to a busy worker keeps exit 78
#   BOUND_INJECT_UNSUPPORTED when inject-bound-v1 is not declared or cannot be
#   read. This package declares no dependency on telepty and installs,
#   upgrades, starts, stops and restarts nothing.
#
# Retry of an unknown delivery (#1092): a prior attempt left at
#   delivery_state_unknown holds every identical dispatch (exit 7,
#   DISPATCH_RETRY_HELD) because bytes may have landed. Once reviewed, the
#   orchestrator lane retries with --retry-unknown "<reason>" on --target or
#   --spawn-and-dispatch: one registry transaction marks the old row superseded
#   and creates the new row with retry_of + the reason in observations[], then
#   the normal inject + ledger + dispatch_ack leg runs. The spawn path retries
#   the existing worker; it never opens a second workspace. Any other row state
#   (transport observed, or no held attempt) refuses the flag with exit 4
#   (DISPATCH_RETRY_REFUSED) naming lifecycle= and transport=, so the override
#   cannot double a known delivery. Without the flag the hold is unchanged.
#
# Ready detection: per-CLI prompt-symbol probe of \`telepty read-screen\` plus
# welcome/boot banner absence (claude ❯ / codex › / gemini ›|│ >).
#
# Follow-up to a BUSY worker (#1270): a \`--target\` that is already working can never show
#   the idle, empty composer the readiness wait requires, so such a dispatch used to time out
#   with nothing delivered. A NON-SPAWNED --target measured as qualified current-busy is
#   admitted at once instead and delivered through \`telepty inject-bound-v1\`, bound to the
#   session epoch and owner generation read from ONE \`telepty list --json\` snapshot. The
#   admission criterion is the probe's reading of the LIVE current viewport: surface=working,
#   ready=false, ready_reason=current-busy-or-modal, tracker_class one of
#   blank/active/prompt_observed. That reason is the ONLY busy spelling live mode produces,
#   and it is required: the offline --screen-file answer (hard-negative) carries no composer
#   guarantee at all, and current-working is unreachable in both modes, so neither is
#   admitted. Fresh --spawn-and-dispatch, modal, unsubmitted, unknown surface, probe error
#   and --retry-unknown are unchanged and stay fail-closed. It requires --from, a loopback
#   session, the bridge's busy-input-v1 capability and the verb in
#   \`telepty boot-capabilities\`; exit 78
#   BOUND_INJECT_UNSUPPORTED names whichever is missing, before any record or any input.
#   That exit CHANGES an existing outcome: a qualified-busy --target whose bridge or local
#   CLI cannot carry the bound verb now dies 78 by name, where before this feature it fell
#   through to the readiness wait and exited 1 on timeout. A lane that reads exit 1 as
#   "busy, retry later" has to read 78 the same way — nothing was transported in either case.
#   Known limitation (probe-side, task 1277): a collapsed one-line Claude viewport and a busy
#   codex whose footer is a bare \`? for shortcuts\` with no warnings suffix are NOT
#   bound-deliverable — for both shapes the probe reports no empty current composer, so the
#   dispatch still ends in the readiness timeout. There is no caller-side workaround, and
#   neither shape is ever written to.
#   Every outcome records transport \`unknown\` plus one bounded observation, never
#   write_observed:
#     exit 0  ACCEPTED_PENDING <sid> — both frames were handed to the pinned owner bridge.
#             REPLACES the \`OK dispatched to <sid>\` line on this path and is NOT a delivery
#             receipt: not a PTY write, not native queueing, not auto-submit, not model
#             receipt. The identity is never re-sent.
#     exit 3  BOUND_INJECT_REFUSED — the answer PROVES nothing was written (pre-socket local
#             refusal, unregistered route, or a closed refusal reporting 0 bytes); recorded
#             not_delivered, so the same ref may be dispatched again. For the one refusal that
#             names an ALREADY stranded instance (\`composer_stranded\`) the re-dispatch only
#             works after an operator clear, and the STRANDED block below says so.
#     exit 7  DELIVERY_UNKNOWN — lost, truncated, mismatched-identity or any other
#             non-accepted answer: input may have been queued or written, so the identity is
#             HELD for review (no replay, no Enter). --retry-unknown does NOT clear a hold
#             on a still-busy worker: the bound path refuses that flag, so the retry falls
#             to the readiness wait and exits 1 having changed nothing. Read the held row
#             (dispatch-registry.py get) and the worker's screen; once the worker is idle
#             again the normal --retry-unknown "<reason>" path applies, because an idle
#             target is delivered by the legacy inject.
#   Stranded composer: a body that reached the composer whose paired CR did not leaves that
#   exact session instance STRANDED — the daemon refuses every later body and key from every
#   producer (\`composer_stranded\`) until an operator clears it. Whenever an answer proves that
#   (a strand-reason \`outcome_unknown\`, or a \`composer_stranded\` refusal) or leaves it
#   unknown (a lost, unparseable, foreign-identity or any other non-accepted answer), a bounded
#   STRANDED block is written to stderr with the pinned session_epoch, the owner_generation, the
#   stranded_inject_id (or \`none\`), the reason code and the recovery procedure: empty the
#   composer at the bridge's own keyboard, then run the printed
#   \`telepty clear-strand-v1 --from <operator-sid> …\` yourself. Any value the answer does not
#   carry is printed as a <placeholder> with the read-only \`telepty session <sid>\` lookup that
#   shows it, never guessed. One strand reason, \`body_outcome_unknown\`, means the body write
#   itself never resolved: the record exists and the block says so, and it also says the composer
#   may be EMPTY — look before typing. THIS HELPER NEVER CLEARS: it runs no clear-strand-v1, sends
#   no key, never retries, replays or takes another input route for a stranded session — it cannot
#   see the composer, so the assertion a clear records must be a human's. The exit codes and
#   markers above are unchanged by the block.
#   --verify-delivered is a declared NO-OP on this path: a queued body is not on the screen,
#   so no screen read is attempted, a stderr NOTE states that verification was not performed,
#   and the exit stays 0. Started-working verification runs observe-only
#   (bin/dispatch-verify.sh --observe-only): no key, no resubmit, and it prints OBSERVED
#   rather than VERIFIED, because a working spinner may predate the queued body.
#`;
