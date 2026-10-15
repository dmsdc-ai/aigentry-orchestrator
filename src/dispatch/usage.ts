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
#`;
