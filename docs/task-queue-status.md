# task-queue status vocabulary (#1108, 2026-09-06)

`state/task-queue.json` `status` is a **closed set of 8**: `pending` · `delegated` · `in_progress` · `blocked` · `blocked-by-observation` · `awaiting-user` · `done` · `cancelled`. Nothing else is valid.
**Status normalizes, notes never do.** `status` is a state label the tools branch on; the `note` is the execution log (Rule 34) and is only ever appended to as a dated `||` segment (Rule 40) — never rewritten, never compressed into the status string.
**ids are unique**; a collided second body becomes `<id>b` (#1110).
Dispatchable (`src/dispatch/cli.ts` `ALLOWED_STATUS`): `pending` · `delegated` · `in_progress` · `blocked-by-observation`. Terminal: `done` · `cancelled`. `blocked` and `awaiting-user` are neither — a blocked row must be unblocked, not dispatched.
`blocked-by-observation` = waiting on live data and still dispatchable; plain `blocked` = waiting on another task, an asset, or upstream.
The 40 pre-normalisation strings and the old→new mapping are archived in commit `chore(1108): task-queue status vocabulary + stale-row closure`; the 5 rows whose old string carried a fact nothing else recorded (#298 #430 #600 #601 #616) also carry it as a `status-was:` note segment.
