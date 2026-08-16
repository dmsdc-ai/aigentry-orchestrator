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
#   dispatch.sh --spawn-and-dispatch --track T --name N --cwd P --cli claude \\
#               --ref <file> [--from <orch-sid>] [--role coder|architect|...] [--worktree P]
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
# --role (cli=claude|codex|gemini, #431 / #532): wires boot-prepare.mjs so the
#   wrapped CLI skips project context-file auto-discovery (the cwd→role
#   contamination exposed by the 2026-05-23 incident). claude uses
#   \`--append-system-prompt-file\`; codex/gemini use the additive path (staged cwd
#   AGENTS.md/GEMINI.md + CODEX_HOME/GEMINI_CLI_HOME shadow home). Omit --role to
#   use the legacy spawn (back-compat).
#
# Registration wait (#727): a freshly spawned worker needs tens of seconds to
#   appear in \`telepty list\` (workspace boot → CLI boot → bridge registration).
#   The spawn path polls every 5s up to AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS
#   (default 180000) before giving up with exit 6, so a slow spawn stays on the
#   gated path instead of being hand-recovered with a raw \`telepty inject\`
#   (which bypasses the task-gate ledger, delivery confirm and tracker register).
#   --target keeps the historical fail-fast; set the knob to make it wait too.
#
# Ready detection: per-CLI prompt-symbol probe of \`telepty read-screen\` plus
# welcome/boot banner absence (claude ❯ / codex › / gemini ›|│ >).
#`;
