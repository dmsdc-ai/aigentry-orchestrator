# Runbook — #608 Phase 1 rollback / observability (ADR §12 BC4)

Phase 1 promotes the cmux spawn into the Workspace Host contract as the 9th verb
`wh_open` (ADR §7 Phase 1, §3 D1). This runbook is the **reverse path** BC4 requires
(ADR §7 had only forward gates) — it protects the live cmux daemon (3848).

## What landed in this branch (orchestrator repo `aigentry-orchestrator`, `wt/608-phase1`)

`bin/lib/workspace-host.sh` only — an **additive, inert** seam:

- `_wh_cmux_open <sid> <cwd> <cli_cmd>` — cmux spawn moved **byte-for-byte** from
  `open-session.sh`'s cmux branch (incl. the `_cmux_wait_ready` 3-part ready-gate,
  re-homed as `_wh_cmux_wait_ready`). Exit contract: `0`+ref / `2` spawn-fail / `3`
  gate-timeout (workspace closed, no handle).
- `_wh_cmux_ready_attestation` → `surface` (capability metadata, BC2 — NOT a 10th verb).
- `wh_open` dispatcher — selects the adapter, **logs the selection** (`_wh_log
  "open: adapter=… sid=…"`, BC4-b observability), and fails LOUDLY (`UNSUPPORTED`,
  rc 64) for adapters whose spawn is not yet migrated (warp=Phase 2, headless=Phase 3).

**Inert** = no production caller invokes `wh_open` yet. `open-session.sh` still uses its
legacy inline cmux path verbatim (see "Deferred" below), so **live cmux spawn behavior is
byte-unchanged** by this branch.

## One-command rollback

Because the Phase 1 lib half is purely additive and has no live caller, rollback is a
plain revert — no runtime flag is needed to protect the daemon:

```bash
# in the aigentry-orchestrator worktree:
git revert --no-edit <phase1-commit-sha>      # or: git checkout HEAD~1 -- bin/lib/workspace-host.sh
```

Verify the live path is untouched:

```bash
bash tests/dispatch/T39_open_session_cmux_readiness.sh   # legacy inline spawn gate — must stay GREEN
bash tests/dispatch/T53_wh_cmux_open_contract.sh          # adapter contract (removed by the revert)
```

## Deferred to the open-session.sh integration (BLOCKED — see HOLD, tq#608 Phase 1)

ADR §7 Phase 1 **step 2** ("`open-session.sh` sources `workspace-host.sh` + the cmux
branch calls `wh_open`") and **BC4-a** (the per-phase `AIGENTRY_WH_LEGACY_SPAWN=1`
fallback flag gating that branch) are **not wired in this branch**: `bin/open-session.sh`
is a **symlink into a separate repo** (`aigentry-devkit`), whose `_resolve_src` makes
`SCRIPT_DIR=devkit/bin` — and `devkit/bin/lib/` has no `workspace-host.sh`. Editing through
the symlink would (a) write off-branch into the live devkit repo and (b) break live spawn
at runtime (`source` of a nonexistent file under `set -euo pipefail`). The integration +
its `AIGENTRY_WH_LEGACY_SPAWN` rollback flag land once the orchestrator resolves the
cross-repo lib-reachability fork. Until then the live spawn IS the rollback (legacy inline,
unchanged).
