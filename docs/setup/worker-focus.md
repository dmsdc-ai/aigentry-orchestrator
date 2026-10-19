# Worker workspaces and focus (#507 / #616)

Policy: the orchestrator's workspace keeps the operator's focus. Worker
workspaces stay visible in the cmux sidebar and never take focus by themselves.

## Spawn

`bin/lib/workspace-host.sh` opens every cmux worker workspace with
`cmux new-workspace --focus false …`. The worker's CLI still runs as the
foreground process of its own surface, and the readiness gate is unchanged.

Before spawning, it checks that `cmux --help` advertises
`new-workspace … --focus`. If not, the spawn fails with exit 2 and
`ERR CMUX_NO_FOCUS_UNSUPPORTED: …` on stderr. Nothing opens, and there is no
fallback that would steal focus. To fix it, upgrade cmux.

Not covered: the opt-in rollback arm `AIGENTRY_WH_LEGACY_SPAWN=1`
(`src/session/open-session/legacy-spawn.ts`) is a verbatim legacy copy. It does
not pass `--focus false`, so leave it unset.

## Surface-mismatch events

When telepty reports a live session whose surface is mismatched
(`state/dispatch/surface-mismatched.jsonl`), the reconciler only records it:

```
SURFACE_MISMATCHED unresolved sid=<sid> host=<workspace:N|?> expectedPty=<pid|?> — diagnostic only; no focus/rebind actuation
```

It never focuses, raises or selects a workspace, and it never switches back to
the orchestrator on its own, so a workspace you selected yourself stays selected.
The file is still drained every tick, and `surface_mismatched consumed=<n>` is
still logged. A mismatch line says nothing about whether the task finished or
whether the session is alive. Inspect or close that surface by hand.

Once this source is active, the temporary isolation of this consumer through
`AIGENTRY_SURFACE_MISMATCHED_SOURCE` is no longer needed. Remove it so the
reconciler supervises these events normally again.
