# Worker workspaces and focus (#507 / #616)

Policy: the orchestrator's workspace keeps the operator's focus. Worker
workspaces stay visible in the cmux sidebar and never take focus by themselves.

## Spawn

`bin/lib/workspace-host.sh` opens every cmux worker workspace with
`cmux new-workspace --focus false …`. The worker's CLI still runs as the
foreground process of its own surface, and the readiness gate is unchanged: the
workspace ref is still emitted only once the pane can accept `send-key`.

Before spawning, the adapter checks that `cmux --help` advertises
`new-workspace … --focus`. If it does not, the spawn fails with exit 2 and
`ERR CMUX_NO_FOCUS_UNSUPPORTED: …` on stderr. Nothing is opened, and there is no
fallback that would steal focus instead — the fix is to upgrade cmux.

Scope: this is the cmux adapter's behaviour. The opt-in legacy rollback arm
`AIGENTRY_WH_LEGACY_SPAWN=1` (`src/session/open-session/legacy-spawn.ts`) is a
verbatim copy of the pre-seam command line and does **not** pass `--focus false`,
so leave it unset if focus matters to you.

## Surface-mismatch events

When telepty reports a live session whose surface is mismatched
(`state/dispatch/surface-mismatched.jsonl`), the reconciler only records it:

```
SURFACE_MISMATCHED unresolved sid=<sid> host=<workspace:N|?> expectedPty=<pid|?> — diagnostic only; no focus/rebind actuation
```

It never focuses, raises or selects a workspace, and it never switches back to
the orchestrator on its own, so a workspace you selected yourself stays selected.
Focusing a window would not have re-bound anything anyway: the mismatch is
between the session's expected PTY and the surface telepty observed, and neither
changes when a window is raised.

The spool is still drained every tick and `surface_mismatched consumed=<n>` is
still logged, so the bus bridge's next batch always finds a free path. A mismatch
line says nothing about whether the task finished or whether the session is
alive. Inspecting or closing that surface is a human call.
