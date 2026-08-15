# Silent-absence sweep — an auth failure can tear down live sessions and report success

Date: 2026-08-01 · Method: 37 independent reviewers over 6 surfaces, each hit adversarially re-attacked
Result: **71 candidates, 21 confirmed** · Status: **blocks telepty #820/#823**

## Why this sweep happened

The same defect had been found three times, each by accident: an **authentication or error failure
degrading into a legitimate-looking absence.** The caller cannot distinguish *"I was refused"* from
*"there is genuinely nothing here."*

1. `bin/dispatch-tracker.sh` folded every non-200 into `observation_endpoint_absent` — a 401 recorded as
   "that endpoint does not exist". (fixed, `36c10e9`)
2. `daemon.js` DELETE emitted no death observation at all. (fixed, `bfd2bec`)
3. `cross-machine.js:471` returned `[]` on both `!res.ok` and `catch`. (found by the design's author)

Three accidents is a pattern, not a coincidence. So we stopped finding them one at a time.

## The finding that matters: one config corruption kills the daemon and tears down sessions

Each link was verified independently. Together they form a chain that **becomes live the moment #820
ships**, because #820 is what makes a 401 reachable on loopback at all.

**Link 1 — `auth.js:18` destroys the shared secret, silently.**
Reproduced in an isolated `HOME`: seed `config.json` with a truncated body, call `getConfig()`. It warns to
`console.warn`, **mints a new UUID, and overwrites the file.** The real shared secret is gone, other keys
are gone, exit 0, nothing thrown. The realistic triggers — partial write, empty file, hand-edit, corrupt
JSON — all leave a file the process owns and can write, so the rotation completes silently.

**Link 2 — the daemon and the CLI now permanently disagree.** `daemon.js:39` freezes `EXPECTED_TOKEN` at
module load; every CLI process re-reads the file. One partial write desyncs a long-lived daemon from every
subsequent CLI call, forever.

**Link 3 — `cli.js:610` blanks the session list.** `if (res.ok) { … }` with **no else**, inside a bare
`catch {}`. A 401 does not throw, so `allSessions` stays empty and `telepty list --json` prints `[]` and
exits **0**. Every command is built on `discoverSessions()`, so one 401 turns `list` into "No active
sessions found", `inject` into "Session not found", `clean` into "✅ No ghost sessions found", and
`broadcast` into "✅ Context broadcasted successfully to **0** active session(s)."

**Link 4 — `session-cleanup.sh:259/284` tears down live sessions and returns 0.** The guard
`telepty_list_json` was built for the *throw*-shaped failure (task #400, contaminated stdout). `jq -e .`
exits 4 on empty input — loud — but exits **0** on `[]`. So the gate passes. The loud 401 handler at
`:240` lives in `delete_session_registry`, reachable only from the loop body that never runs when the list
is empty: **the batch path structurally cannot reach it.** Verified empirically with a stub `telepty` on
PATH: `--all-disconnected` printed `cleaned: 0 disconnected sessions` and exited 0. On the single-sid path
it closes the live worker's cmux surface, deletes the registry entry, and returns success.

**Link 5 — `cli.js:196/801` then kills the healthy daemon.** `sessionsReachable = !!(sessionsRes &&
sessionsRes.ok)` collapses 401 into "nothing answered"; neither it nor `getDaemonMeta` reads `res.status`.
`decideDaemonAction` returns `{action:'start', reason:'daemon-unreachable'}` — a verdict that **authorizes
a kill**: `restartDaemonGraceful → cleanupDaemonProcesses → stopDaemonProcess` SIGTERM/SIGKILL against the
state-file pid, scanned pids, and the confirmed port owner. That daemon is alive, healthy, correct-version,
and **parent to every `pty.spawn` session**. Three retries. If the replacement then accepts the token, the
operator sees only "Auto-starting local telepty daemon" and a success.

**Net effect: a partial write to one config file can, after #820, kill the process that owns every live
session — while every surface reports success.**

## Confirmed hits (21 of 71 candidates)

| Surface | Confirmed |
|---|---|
| `cli.js` / `cross-machine.js` | `cli.js:610`, `:3030`, `:196`, `:801`; `cross-machine.js:475`, `:485` |
| `daemon.js` | `:4447`, `:317`, `:3181` |
| transport / protocol | `websocket.js:539`, `http-auth.js:93` |
| rest of `src/` | `auth.js:18`, `win-kill-process.js:44`, `provenance.js:41` |
| orchestrator `bin/*.sh` | `session-reconciler.sh:773`, `dispatch.sh:349`, `session-cleanup.sh:259`, `:284`, `session-comms-auditor.sh:203`, `ask.sh:118` |
| orchestrator `src/` | `virtual-fs.ts:22` |

`websocket.js:539` deserves its own note: a raw `HTTP/1.1 401 Unauthorized` on the upgrade surfaces in the
`ws` client as `error` + close 1006 — **indistinguishable from "the daemon is down."**

## Consequences for the release

1. **#820/#823 cannot ship before Links 1, 3, 4 and 5 are fixed.** The security fix is what makes the chain
   reachable. This is the same shape as #826 — *the fix creates the hazard* — but destructive rather than
   merely misleading, so it is a blocker rather than a scope decision.
2. **Fix direction is the same everywhere:** a *response* that arrives and declines is not an absence.
   Distinguish "refused" (401/403) from "broken" (5xx) from "unreachable" (connect error). `[]` is only
   correct for the last one.
3. **`session-cleanup.sh`'s guard must reject `[]`-with-exit-0**, not only non-JSON and non-zero exit — and
   the batch path must be able to reach the loud handler.
4. **`auth.js` must never overwrite a config it failed to parse.** Fail closed; a corrupt secret is a
   condition to report, not to silently replace.

## Method note

Each candidate was re-attacked by an independent reviewer instructed to return HARMLESS or UNREACHABLE if
it could show either; 10 of 31 verified candidates were dismissed that way. The `auth.js:18` reviewer
reported "tried to knock it down four ways; it survived all four, and the investigation made it worse than
reported" — the corrupt-read rotation was found during the attempt to dismiss it.
