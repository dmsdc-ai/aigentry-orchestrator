# ADR 2026-11-23 — Every terminal through one layer; Warp at parity (task 1304)

Status: ACCEPTED 2026-11-23 for implementation. User decisions: the requirement covers the Mac and Linux alike (so D3 stands — tmux is the only control surface that exists on both); running the real Warp app on the Mac for verification is approved; macOS Accessibility is granted (measured: the visible Warp tab's text and title are readable; background tabs and Linux are not covered by it).
Owner task: 1304 (current hotfix). Related: 1303 (spawn defects), ADR 2026-06-13 terminal adaptor contract.

## Requirement
User, 2026-11-23: every orchestrator function must work under Warp on the Mac; whatever does not must be
built behind an abstraction; every terminal works through that one layer. Worker spawn must work on every
machine (Mac and Linux).

## What was measured
Read-only audit of branch `feat/controller-link-v1` (137 terminal call sites; audit and call-site table kept
with task 1304):
- 98 call sites go through the Workspace Host layer (`bin/lib/workspace-host.sh`), 29 call a terminal
  directly, 10 need no terminal (telepty, OS).
- Only cmux has ever been exercised. For Warp: `open` writes a tab config schema Warp does not execute
  (measured on the Mac with Warp 0.2026.06.24 and reported from Linux with 0.2026.10.21); close, alive, list
  and focus are degraded (window-title substring match, a sentinel nobody removes); prune, status and agent
  metadata do nothing; reading the current screen does not exist outside cmux.
- The adapter that spawned a worker is not remembered. Every later verb picks "cmux if installed, else
  headless", so a Warp worker is never closed and nothing reports it.
- Dispatch readiness (is the worker's prompt ready for input) reads the screen through cmux only. A worker
  in any other terminal never becomes ready and dispatch fails.
- tmux, wezterm, iterm and aterm have a spawn function only; a lifecycle verb on them runs an undefined
  function. Through the TypeScript opener the tmux and iterm spawns cannot work at all, because
  `bin/wh-cli.sh` never loads `bin/lib/platform.sh`.
Not measured: whether Warp closes a tab whose process exited; whether macOS Accessibility can read Warp
pane text; what telepty reports for a session hosted in Warp.

## Decisions

### D1 — One door, enforced by a test
All terminal access goes through the Workspace Host verbs, reached from TypeScript only via `bin/wh-cli.sh`.
A guard test (`tests/dispatch/T1304_terminal_layer_guard.sh`) fails when product code names a terminal tool,
a terminal environment marker or a cmux-owned handle outside the layer. Existing direct uses are either
moved behind the layer in this task or pinned in an allowlist with an exact count and a written reason, so
they cannot grow. A second assertion requires, for every registered adapter and every verb, either an
implementation or an explicit `unsupported` answer (exit 20, one labelled line) — never an undefined
function, never a silent success.

### D2 — The adapter follows the session
A successful `open` writes one record per session id (adapter name and host handle) under
`~/.aigentry/workspace-host/`. Lookup, close, alive, focus, status and prune resolve the adapter from that
record; an explicit `AIGENTRY_WORKSPACE_HOST` still wins; with neither, today's rule applies and one line
says the adapter is unknown. `TERM_PROGRAM=WarpTerminal` selects warp for a controller started inside Warp;
it is absent in tool shells and under launchd, so the supported way to pin a machine's terminal is the
existing environment variable, documented in the setup guide.

### D3 — Warp shows, tmux controls
Warp has no control interface: its URI scheme can open a tab and nothing else. So a worker in Warp runs
inside its own tmux session, and the Warp tab only attaches to it:
the tab config's command is `tmux new-session -A -s <name> -c <cwd> <worker command>`, which creates the
session and attaches in one step, with no typed input (field-verified on Linux with a Korean input method
active; the tab opens in the controller's existing window).
tmux then gives every missing primitive on both operating systems, without Accessibility permission:
- current screen: `tmux capture-pane -p`
- alive: `tmux has-session`
- close: `tmux kill-session` (then the tab config and record are removed)
- list / prune: `tmux list-sessions` filtered by the name prefix
tmux becomes a requirement for the warp adapter. If tmux is missing, `open` with warp fails at once with
one line naming the missing tool and how to choose another adapter; there is no silent fallback to an
invisible worker. The same primitives complete the plain tmux adapter (controller already inside tmux).
Focus and status stay honest: tmux cannot raise a Warp tab, so `focus` raises the Warp window through
macOS Accessibility when that permission exists and otherwise answers `unsupported`; Warp has no sidebar,
so `set_status` answers through a declared capability `none` instead of pretending.

### D4 — A screen-read verb
`read_screen <session>` joins the layer (cmux: its own reader; warp and tmux: capture-pane; others:
`unsupported`). Dispatch readiness and the session probe call this verb instead of cmux. When the adapter
answers `unsupported`, dispatch stops immediately with `READINESS_UNATTESTABLE adapter=<name>` instead of a
timeout that looks like a slow worker. This reopens the nine-verb boundary of the 2026-06-13 ADR on
purpose: readiness is consumed outside `open`.

### D5 — Corrections that need no design choice
- Tab config writer uses the documented schema (top-level `name`, `title`; one `[[panes]]` with `id`,
  `type = "terminal"`, `directory`, `commands`), TOML basic strings with escaping.
- `bin/wh-cli.sh` loads `bin/lib/platform.sh` so the tmux and iterm spawns work through the TypeScript opener.
- Warp honours `AIGENTRY_WORKER_AUTO_RESTART`; headless `alive` answers indeterminate, not gone.
- The reconciler resolves surfaces through `lookup`, not through cmux-specific fields.

## Not in this task
Full lifecycle for wezterm, iterm and aterm (they answer `unsupported` explicitly after D1); retiring the
legacy cmux revert switch and the kitty tools (reported, user decision later); a no-focus-steal option for
Warp; any change to telepty.

## Order of work and verification
A. D5 schema + platform load, D2 record, D3 warp-on-tmux, D4 read verb — then, on the Mac with the real
   Warp: spawn a Claude worker and a Codex worker, see the tab open in the same window, dispatch passes
   readiness, the worker answers an injected prompt, cleanup removes the session and the tab; repeated with
   a second Warp window open and the Korean input method active. The Linux controller repeats it on Linux.
B. D1 guard test and explicit `unsupported` answers; status capability; prune; focus.
Each step: confined coder, CI on macOS/Linux/Windows, Snyk, independent review. Contract tests use stub
binaries; the real-app run is a manual checklist whose evidence is kept with the task.

## What the user decides
1. tmux as a requirement of the warp adapter (D3). Alternative A: change telepty to expose the current
   screen (touches the live transport, against the standing "no structural change to telepty" decision).
   Alternative B: accept "process started" as ready for Warp (weakens the readiness guarantee; workers can
   miss their first prompt). Recommendation: D3 as written.
2. Running the real Warp app on this Mac for the verification (tabs open in a Warp window and take focus).
3. macOS Accessibility permission for `focus` only — optional; without it focus answers `unsupported`.
