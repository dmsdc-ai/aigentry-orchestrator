# Worker workspaces and focus (#507 / #616)

Two **opt-in** settings for operators who do not want a worker to take the screen. Both
default to OFF, and with both unset this package behaves exactly as it did before they
existed — on every terminal adapter and every cmux version. Nothing here changes unless you
set something.

| setting | default | effect when set to `1` |
|---|---|---|
| `AIGENTRY_CMUX_BACKGROUND_SPAWN` | unset = off | a cmux worker workspace is **created in the background** |
| `AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY` | unset = off | a surface-mismatch event is **recorded, not actuated** |

The two settings treat other values differently:

- `AIGENTRY_CMUX_BACKGROUND_SPAWN` refuses any value other than `1` or `0` (the empty string
  included) rather than guess: the launch exits 2 with the variable named on stderr, before
  anything is spawned.
- `AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY` is on for exactly `1` and nothing else. Every
  other value, `true` included, means off — silently, with no warning and no exit.

## Background creation — `AIGENTRY_CMUX_BACKGROUND_SPAWN=1`

With this set, `bin/lib/workspace-host.sh` opens a cmux worker workspace with
`cmux new-workspace --focus false …`, so creating it does not move your selection. The
workspace is still listed in the sidebar, the worker's CLI still runs as the foreground
process of its own surface, and the readiness gate is unchanged: the workspace ref is still
emitted only once the pane can accept `send-key`.

**Unset (the default), nothing changes.** The adapter builds the same
`new-workspace --cwd … --command …` argument vector it always has, asks cmux nothing
beforehand, and cannot fail in any new way. This matters because a cmux that does not know
`--focus` may ignore the flag and take focus anyway, or fail, so the option cannot be
applied blindly — and the cost of checking must not fall on people who never asked for it.

### How support is established, and the two refusals

When you opt in, the adapter first reads `cmux --help` and looks for the **exact** option
`--focus` **followed directly by a boolean value placeholder** (`<true|false>`, `[true|false]`,
`{true,false}`, `=<bool>`, `true|false`, …) inside the `new-workspace` block of the help text
(the command's own line plus its indented continuation lines, so both one-line and
multi-line help layouts work). A bare `--focus` switch whose description merely mentions
`bool` does not count. Then, and only then, does it spawn.

Two different refusals, both exit 2 with nothing spawned:

| stderr | meaning | what to do |
|---|---|---|
| `ERR CMUX_FOCUS_UNSUPPORTED: …` | the top-level help was read and documents no `new-workspace --focus <true\|false>` | upgrade cmux if it predates the option, or unset the setting |
| `ERR CMUX_FOCUS_PROBE_FAILED: …` | `cmux --help` failed or printed nothing, so support is **unknown**, not absent | fix the cmux install, or unset the setting |

They are kept apart on purpose: "your cmux is too old" and "I could not ask your cmux"
need different actions, and reporting the second as the first sends you after the wrong
fault. There is deliberately no fallback that would open the workspace in front of you
instead, and no refusal of any kind on a default (not opted-in) launch.

What this check cannot do: it reads cmux's own description of itself, and only the top-level
`cmux --help`. A cmux that lists the option only under `cmux new-workspace --help` is refused
as unsupported although it has the option; the subcommand's help is not run, because on a
cmux that does not treat `--help` there as help, that call could itself open a workspace. A
help layout outside the shapes above may likewise be refused. A cmux that documents the
option and then ignores it would still take focus, and no pre-spawn check can detect that
without spending a workspace to observe it.

**Scope.** This is the cmux adapter only. Other adapters keep their launch commands, and the
opt-in legacy rollback arm `AIGENTRY_WH_LEGACY_SPAWN=1`
(`src/session/open-session/legacy-spawn.ts`) is a verbatim copy of the pre-seam command line
and does **not** pass `--focus false`, so leave it unset if background creation matters to
you.

## Surface-mismatch events — `AIGENTRY_SURFACE_MISMATCH_DIAGNOSTIC_ONLY=1`

When telepty reports a live session whose surface is mismatched
(`state/dispatch/surface-mismatched.jsonl`), the reconciler's default behaviour is the
existing one: resolve the sid to a host id and focus it, logging
`SURFACE_MISMATCHED refocused sid=… host=… expectedPty=…`. On cmux that selects the
workspace; on Warp it raises the window; headless does nothing.

The reconciler reads this setting from its own process environment, which every tick
inherits from the long-lived `--loop` process (the one its launchd agent or systemd unit
starts): set it in that environment and restart that process. Exporting it only in the shell
that launches workers changes nothing. Only exactly `1` turns it on; any other value leaves
the default behaviour, without a warning.

With the setting at `1`, the event is only recorded:

```
SURFACE_MISMATCHED unresolved sid=<sid> host=<workspace:N|?> expectedPty=<pid|?> — diagnostic only; no focus/rebind actuation
```

Nothing is focused, raised or selected, and nothing switches back to the orchestrator, so a
workspace you selected yourself stays selected. Focusing a window does not re-bind anything
anyway: the mismatch is between the session's expected PTY and the surface telepty observed,
and neither changes when a window is raised.

**Why this is an option and not the new default.** This consumer is adapter-independent,
while the complaint it answers is about a cmux spawn path. Dropping the actuation for
everybody would silently remove the only visual cue a Warp operator gets, which is not a
trade to make on their behalf. So the actuation stays, and you can turn it off.

In both arms the spool is drained every live tick and `surface_mismatched consumed=<n>` is
logged, so the bus bridge's next batch finds a free path. Under `--dry-run` neither arm
reaches a host adapter at all and the spool is left in place. A mismatch line says nothing
about whether the task finished or whether the session is alive. Inspecting or closing that
surface is a human call.

## Warp workers — `tmux` is required

Warp can only open a tab from outside; nothing else in it can be driven. A worker spawned
with the `warp` adapter therefore runs inside its own tmux session (`aigentry-warp-<sid>`,
with `.` written as `%2E`), and the Warp tab only attaches to it, in the active Warp window.
Readiness, liveness, close and the screen read all go through tmux on macOS and Linux
alike; macOS Accessibility is used only to raise the window for focus (exact title match).

- Install `tmux` on every machine that spawns Warp workers, and make sure it is on the PATH
  of the processes that close them (the reconciler and `session-cleanup.sh`). Without tmux,
  a Warp spawn fails at once with exit 2 and leaves nothing behind.
- `TERM_PROGRAM=WarpTerminal` selects Warp for a controller started inside Warp. Tool
  shells and launchd do not carry it, so pin a machine's terminal with
  `AIGENTRY_WORKSPACE_HOST=warp` in the controller's environment.
- Each spawn records its adapter in `~/.aigentry/workspace-host/<sid>.rec`
  (`AIGENTRY_WH_STATE_DIR` overrides the directory), so later close, liveness and focus
  calls reach the right terminal without the override. A session without a record keeps
  the old rule (cmux if installed, else headless), and a line on stderr says so.
- Warp has no sidebar, so status pills are a no-op there.
- A worker hosted outside cmux never gets the controller's terminal identity: every
  non-cmux spawn starts the worker through `env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID
  -u CMUX_TERMINAL_LIFECYCLE_ID -u TELEPTY_SESSION_ID …`. This matters because a tmux server
  started from a cmux shell keeps that shell's environment for every later session.
- `wh-cli.sh close` and `close-for-sid` release the surface only, and they refuse (exit 4,
  nothing closed) a surface the caller itself runs in. A closed session keeps a tombstone
  (`<sid>.closed`), so a later `session-cleanup.sh <sid>` still uses the adapter that
  opened it. Ending the worker's `telepty allow` process and its registry entry is
  `session-cleanup.sh`'s job.

## Packaging note

This file is not listed in `package.json` `files`, so it is in the repository but not in the
published tarball; that list names setup docs individually. Add it there if a release should
ship it — that is a packaging decision, not part of this change.
