// What `open-session.sh --help` prints, kept verbatim as contract (#899 tranche 3a).
//
// The shell answered --help with `sed -n '2,30p' "$0"` — its own header, printed
// out of the file itself. bin/open-session.sh is an exec shim now, so those 29
// lines live here instead, byte-for-byte. The last of them is the script's
// `set -euo pipefail`: sed included it, so it is part of the output nobody chose
// and everybody has seen, and dropping it would be a contract change dressed as a
// cleanup. Same idiom as src/hitl/usage.ts (tranche 2d).
//
// One line per array element so the bytes stay auditable against the original:
//   git show 736707a:bin/open-session.sh | sed -n '2,30p'
export const USAGE: string =
  [
    "# open-session.sh — Open an aigentry session in the user's current terminal environment",
    "#",
    "# Cross-terminal universality (헌법 Rule 2 크로스 + Rule 14 범용 블로킹 금지 + Rule 17 무의존):",
    "#   Detects host terminal (cmux / aterm / tmux / wezterm / iTerm / ghostty / generic)",
    "#   and spawns a visible UI container that wraps the CLI in `telepty allow --id <sid>`.",
    "#   This guarantees BOTH:",
    "#     1. Backend: telepty daemon registers the session (`telepty list`, inject targets work)",
    "#     2. Frontend: user sees the session in their actual terminal",
    "#",
    "# Two-layer flag design (Rule 14 generic/multi-cross):",
    "#   Layer 1 (generic): --cwd always works. No project-name assumptions.",
    "#   Layer 2 (optional): --role looks up ~/.aigentry/config.json for user-specific shortcut",
    "#",
    "# Session id (SID) convention: {track}-{name}  (e.g. \"B-architect-264\")",
    "#",
    "# Usage:",
    "#   open-session.sh --track B --name architect-264 --cwd ~/repos/my-design --cli claude",
    "#   open-session.sh --track A --name bench-250 --cwd /tmp/bench-orch",
    "#",
    "#   # With ~/.aigentry/config.json configured:",
    "#   open-session.sh --track B --role architect --task 264",
    "#",
    "# Default per-CLI flags (applied only when --extra-flags + config cli_flags both empty):",
    "#   claude default flags: --permission-mode bypassPermissions",
    "#   codex default flags: -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox",
    "#   gemini default flags: -m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash} --approval-mode yolo",
    "#",
    "# Output: session ref on stdout (cmux: \"workspace:N\", others: SID)",
    "set -euo pipefail",
  ].join("\n") + "\n";
