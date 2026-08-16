# #899 tranche 2c — `bin/session-reconciler.sh` → TypeScript: DISPOSITION TABLE

Phase 1 deliverable. Nothing is implemented yet; this is the measured plan the
implementation is held to. Every row was read out of the file, not out of prose
(Rule 39). Target measured at **1128 lines, 35 functions, 3 sourced libs**
(`:110 lib/platform.sh`, `:112 lib/workspace-host.sh`, `:117 lib/telepty-listing.sh`).

Allowed dispositions, as the dispatch fixed them:

* **(a) stays a subprocess** — identical argv. Default for anything already ported
  to TS and for the python trio.
* **(b) subprocess door** — for sourced bash libs (`bin/wh-cli.sh` verbs;
  `bash -c '. "$1"; fn …'` for the rest).
* **(c) in-process TS** — the reconciler's *own* logic only.

---

## 1. Subprocess children — `child | today | after T2c | why`

| child | today (line) | after T2c | why |
|---|---|---|---|
| `CLEANUP_SH` = `bin/session-cleanup.sh` | `"$CLEANUP_SH" "$sid"` (:498) | **(a)** `spawnSync(CLEANUP_SH, [sid])`, stdio ignored | already TS behind its own shim (T2a, 988fb69). Calling it in-process would fork a second copy of the Rule 28 protected-sid refusal and the #524 worker guard. |
| `DISPATCH_SH` = `bin/dispatch.sh` | `--target <sid> --ref <ref> --verify-delivered --no-task "reconciler-redispatch <sid>"` (:304) | **(a)** identical argv | already TS (T1). The rc 0/7/8 trichotomy at :306-332 is a contract *of that CLI*; re-implementing the verify-delivered handshake here would be a second copy of it. |
| `TRACKER_SH` = `bin/dispatch-tracker.sh` | `"$TRACKER_SH" check` behind `[ -x ]` + `DRY_RUN=0` (:919-921) | **(a)** identical argv, same two gates | already TS (T1b). It is the *forwarder being gated* by `AIGENTRY_HOST_POWER_STATE` — which it reads from the environment this tick exports (:908). |
| `SCHEDULER_SH` = `bin/dispatch-cleanup-scheduler.sh` | `"$SCHEDULER_SH" tick` behind `[ -x ]` + `DRY_RUN=0` (:961-963) | **(a)** identical argv | stays bash; not a #899 target. |
| `COMMS_AUDITOR_SH` = `bin/session-comms-auditor.sh` | `TELEPTY=… "$COMMS_AUDITOR_SH"` behind `[ -x ]` + `DRY_RUN=0` (:929-931) | **(a)** identical argv, `TELEPTY` in the child env | stays bash. |
| `BRIDGE_AUDITOR_SH` = `bin/orchestrator-bridge-auditor.sh` | `TELEPTY=… "$BRIDGE_AUDITOR_SH"` behind `[ -x ]` + `DRY_RUN=0` (:939-941) | **(a)** identical argv | stays bash. |
| `BUS_BRIDGE_SH` = `bin/telepty-bus-bridge.sh` | `TELEPTY=… "$BUS_BRIDGE_SH" --ensure` behind `AIGENTRY_BUS_BRIDGE != 0` + `[ -x ]` + `DRY_RUN=0` (:956-958) | **(a)** identical argv, all three gates | stays bash. `AIGENTRY_BUS_BRIDGE=0` is the hermetic-test kill switch (`tests/dispatch/lib.sh`) and must keep working. |
| `HITL_SH` = `bin/hitl.sh` | `"$HITL_SH" remind` (:884) and `"$HITL_SH" open …` (:274), each behind `[ -x "$HITL_SH" ]` | **(a)** identical argv, `[ -x ]` gate KEPT | **T2d ports this, not T2c.** ADR amendment #925 (PR #12) is pending and both callers must keep gating on `[ -x bin/hitl.sh ]`. |
| `POLICY_PY` = `bin/policy.py` | `printf '%s\n' "$state" \| "$POLICY_PY" --status <s> --state -` (:227), stderr dropped, failure → literal ESCALATE fallback JSON | **(a)** identical argv + stdin; same fallback string | python by design, same as T1/T1b/T2a. |
| `SESSION_PROBE_PY` = `bin/session-probe.py` | `TELEPTY=… "$SESSION_PROBE_PY" --sid <sid>` (:233), stderr dropped, empty → literal fallback state JSON | **(a)** identical argv; same fallback string | python by design. |
| `DISPATCH_REGISTRY_PY` = `bin/dispatch-registry.py` | `registry()` wrapper (:194). Verbs measured: `list --live --fields assigned.sid,lifecycle.state,ref_path,re_dispatch_count` (:582), `list --not-retired --fields assigned.sid` (:621), `list --keep-alive --fields assigned.sid` (:627), `set-lifecycle --sid --state --now` (:199), `set-lifecycle … --bump-re-dispatch-count --extend-minutes 30 --now` (:308), `observe --sid --kind redispatch_suppressed_duplicate\|redispatch_held_delivery_unknown --field ref_path=… --now` (:313,:325) | **(a)** identical argv for all 6 call shapes | python by design; it is the one transactional component (telepty#60 Stage A). |
| `TELEPTY` (the binary) | `list --json` (:637), `send-key <sid> <key>` (:472), `inject --submit-force --from <orch> <sid> <msg>` (:436,:549), `command -v "$TELEPTY"` (:435,:548) | **(a)** identical argv | the `TELEPTY` env seam is what every guard stubs. |
| `jq` | listing field extraction (:638,:744,:800,:994,:1107,:1125) and `.[].id` selects | **(c)** `JSON.parse` in-process, T2a precedent | the raw bytes still reach `telepty_listing_trusted` **through the bash door**, so the #835 verdict is not re-implemented. `jq` remains a real dependency of the doors (`telepty-listing.sh`, `wh-cli.sh` adapters). |
| `python3` heredocs ×10 | `now_iso` (:126), `append_shadow_record` (:145), `json_get` (:171), `emit_escalation` (:209), `resume_ledger` (:361), `seconds_since_iso` (:667), `backoff_ready` (:680), `backoff_record_failure` (:702), `backoff_reset` (:722), `hitl_pause_gates` (:834), candidate filter (:1016), sweep `state_json` builder (:1062) | **(c)** in-process TS | these are the reconciler's own logic — clock, JSON shaping, ledger arithmetic, backoff math. Exactly the class the dispatch reserves for (c). |
| `mktemp` / `wc` / `head` / `tail` / `cut` / `paste` / `sort` / `tr` / `sed` / `grep` / `rm` | throughout (`:136,:539-546,:967-968,:1107-1108`) | **(c)** in-process TS | shell plumbing, no contract. |
| `kill -0 <pid>` (`pid_alive`, :650) | in-process bash builtin | **(c)** `process.kill(pid, 0)` | a builtin, not a child; there is no lib to route it through. |

## 2. Sourced-lib functions — `function | today | after T2c | why`

| function | today (line) | after T2c | why |
|---|---|---|---|
| `platform::host_power_state` | `host_power_state()` memo (:527) | **(b)** `bash -c '. "$1"; platform::host_power_state'` | verbatim the seam `src/tracker/cli.ts:319` already uses. Memoised once per tick exactly as today (pmset ~1.2s), then exported as `AIGENTRY_HOST_POWER_STATE` (:908) so the tracker child inherits it. |
| `platform::lid_closed` | `check_lid()` (:565) | **(b)** same door; **exit code is the value** (0 closed / 1 open / 2 unknown) | Rule 26: the OS primitive stays in the platform lib. `AIGENTRY_IOREG` (T103's seam) reaches it by env inheritance. |
| `platform::session_pid` | `parent_pid_for_sid()` (:662) | **(b)** same door, one arg | #909 moved this ps/awk out of the reconciler precisely so `open-session.sh` and this sweep judge the same pid. A TS `ps` re-implementation would restore the drift that change removed. |
| `wh_lookup` | :754, :807, :1057 (2-arg form with `sid_json`) | **(b)** `bin/wh-cli.sh lookup <sid> [json]` | the door built for this in pre-T2; T104 pins CLI == sourced function. |
| `wh_close` | :756 | **(b)** `wh-cli.sh close <host_id>` (0 = released/gone, 1 = still alive) | " |
| `wh_alive` | :1058 | **(b)** `wh-cli.sh alive <host_id>` (0 = alive **or cannot-probe**) | the INV-17 INDETERMINATE→alive bias lives in the lib and must not be restated. |
| `wh_focus` | :809 | **(b)** `wh-cli.sh focus <host_id>` | " |
| `wh_prune_orphans` | :1111, `2>/dev/null \|\| echo 0` | **(b)** `wh-cli.sh prune-orphans <live_csv> <protected_csv>` | **⚠ one real seam change:** the lib reads `$DRY_RUN` (workspace-host.sh:209) and today inherits it as a *plain shell variable* of the same process (:1110 says so explicitly). Across a process boundary it must be **exported into the child env**. This is the single highest-risk line of the port: get it wrong under `--dry-run` and the tick closes real workspaces. Pinned by a new guard. |
| `wh_set_status` | :1121-1122 | **(b)** `wh-cli.sh set-status <host_id> <state>` | " |
| `telepty_listing_trusted` | `telepty_list_json()` (:642) | **(b)** `bash -c '. "$1"; telepty_listing_trusted "$2"'` — the exact idiom `src/cleanup/cli.ts:139` uses | **do NOT reimplement the #835 verdict in TS** (dispatch, explicit). One implementation, now three callers (cleanup TS, reconciler TS, orchestrator-boot bash). |
| `telepty_sid_live` | `hitl_open()` subject check (:264) | **(b)** same door; **three-valued exit preserved** (0 live / 1 absent-and-trustworthy / 2 UNKNOWN) | #835/#836: collapsing 2 into 1 is the defect one layer up. `1` ⇒ `HITL_GATE_STALE` alert + no gate; `0` and `2` ⇒ gate opens. |
| `telepty_auth_token` | not called directly | — | reached only transitively inside `telepty-listing.sh`. T87's "exactly one authToken reader under bin/" is untouched by this tranche. |

Everything else — the 35 functions minus the wrappers above — is **(c) in-process TS**:
`usage` (→ `src/reconciler/usage.ts`, replacing `sed -n '2,32p' "$0"`), `log`,
`emit_alert`, `emit_escalation`, `now_iso`, `atomic_write_json`,
`append_shadow_record`, `json_get`, `registry_set_lifecycle`, `policy_decide`,
`probe_session`, `hitl_open`, `maybe_redispatch`, `resume_ledger`,
`resume_latch_clear`, `resume_worker`, `apply_action`, `deliver_sleep_digest`,
`check_lid`, `run_registry_loop`, `run_shadow_loop`, `compute_gc_root`,
`keep_alive_sids`, `telepty_list_json`, `pid_alive`, `seconds_since_iso`,
`backoff_ready`, `backoff_record_failure`, `backoff_reset`,
`consume_surface_orphaned`, `consume_surface_mismatched`, `hitl_pause_gates`,
plus the step 0a → 2b tick sequencing and `--loop`.

## 3. The 16 guards — sourced vs invoked vs comment-only

**SOURCED: ZERO.** Measured: `grep -rn '^\s*\(\.\|source\)\s.*session-reconciler'`
over `tests/` matches nothing. No guard, and no production caller, ever sourced
this file. **Consequence: T2c needs NO `__probe` subcommands at all** — unlike
T2a (whose T52 sourced `session-cleanup.sh`) and T1 (12 guards on
`DISPATCH_SH_NO_MAIN`). The `__probe` surface stays absent.

**INVOKED as a subprocess (13)** — all keep working through the shim unchanged:

| guard | how it invokes | notes |
|---|---|---|
| T17 `lifecycle_3layer` | `"$RECON" --once` | |
| T22 `reconciler_gc_root_and_sweep` | `"$RECON" --once` | |
| T26 `reconciler_inv17_surface_gone` | `bash "$RECONCILER" "$@"` | `bash <shim>` — the shim stays a bash script, so this form survives |
| T29 `reconciler_shadow_loop` | `"$…/session-reconciler.sh" --shadow` | the only `--shadow` guard |
| T31 `autoreport_wiring` | `"$RECONCILER" "$@"` | |
| T62 `hitl_blocking_status` | `"$RECON" --once` | |
| T63 `hitl_destructive_pause` | `RECONCILE_SHADOW_LOG=… "$RECON" --once` | the level-triggered destructive-gate → `DRY_RUN=1` rule |
| T74 `deduped_redispatch_does_not_advance` | `"$…/session-reconciler.sh" --once` | uses the **real** `bin/hitl.sh` (HITL_SH not stubbed) |
| T90 `reconciler_refusal_is_not_absence` | `bash "$RECONCILER"` (no flag) | pins the `$CURL` seam *because* the shim hardens PATH |
| T95 `bus_bridge` | `bash "$RECONCILER" "$@"` | |
| T98 `orchestrator_stale_alert` | `env "$@" bash "$RECONCILER"` + `[ -x "$RECONCILER" ]` | the `-x` check is on the shim → still true |
| T102 `sleep_cut_auto_resume` | `env "$@" bash "$RECONCILER"` | |
| T103 `sleep_telemetry_gate_and_lid` | `env "$@" bash "$RECONCILER"` | |

**STATIC-TEXT ASSERTION (1)** — `tests/workspace-host/prune-status.sh:171`:
`grep -q 'HOME:=' "$RECONCILER"`. **This is why the HOME recovery (`: "${HOME:=…}"`;
`export HOME`, :47-48) and the PATH hardening (:39) STAY IN THE SHIM, in bash.**
They must apply to the node process *and every child it spawns*, the shim is what
launchd executes, and keeping them there means this guard needs **zero edits**.
Placing them in TS instead would break it and would leave `wh-cli.sh`/`hitl.sh`
children running with the wrong `HOME` for one process generation. (Not in CI —
it needs a live cmux — but it is the guard that pins the 2c12619 regression.)

**COMMENT-ONLY (3)** — name the file in prose, assert nothing: T100:12, T104:5,
T23:78. Zero edits.

**Guards I expect to touch, with why:** none of the 17 above, plus these adds —
`tests/dispatch/T110_reconciler_parity.sh` (new, parity vs the ORIGINAL bash),
`tests/dispatch/T111_reconciler_workspace_shim.sh` (new, T105-style two-layout
dist resolution), and `tests/dispatch/run-all.sh` `EXPECTED_GUARDS` 105 → 107
(+2 mine; sw904 takes T107-T109 — see §6). If RED demands more, each new number
is named in the REPORT.

## 4. Env seams the guards drive

| seam | default | driven by | disposition |
|---|---|---|---|
| `RECONCILER_NOW` | live UTC | T22 T26 T31 T62 T63 T74 T90 T95 T98 T102 T103 | (c) `nowIso()` returns it verbatim when set |
| `DRY_RUN` | `0` (argv `--dry-run`) | T26 T63, and the destructive-gate escalation (:895) | (c) internal — **but must be EXPORTED to the `wh-cli.sh prune-orphans` child** (§2) |
| `DISPATCH_STATE_DIR` | `$REPO/state/dispatch` | every reconciler guard, via `tests/dispatch/lib.sh` | (c) |
| `HITL_STATE_DIR` | `$REPO/state/hitl` | T62 T63 T74 T90 | (c) `<dir>/pending` scan |
| `SCHEDULER_SH` `CLEANUP_SH` `DISPATCH_SH` `TRACKER_SH` `COMMS_AUDITOR_SH` `BRIDGE_AUDITOR_SH` `BUS_BRIDGE_SH` `HITL_SH` | `$SCRIPT_DIR/<name>` | T17 T22 T26 T31 T62 T74 T90 T95 T102 T103 | (a) path override honoured identically; `SCRIPT_DIR` = `AIGENTRY_SHIM_SCRIPT_DIR` |
| `SESSION_PROBE_PY` `POLICY_PY` `DISPATCH_REGISTRY_PY` | `$SCRIPT_DIR/<name>` | T74 (probe); others default | (a) |
| `TELEPTY` | `telepty` | every guard (stub binary) | (a) |
| `TELEPTY_PORT` | `3848` | T90 (pinned to 1 as a belt) | reaches `telepty-listing.sh` by env inheritance |
| `CURL` | `curl` | T90 | consumed **inside** `telepty-listing.sh` — inherited, not re-read here |
| `RECONCILER_AGE_FLOOR` / `RECONCILER_DISCONNECT_FLOOR` | 300 / 240 | T22 T26 | (c) |
| `RECONCILER_BACKOFF_INITIAL` / `_MAX` | 5 / 1000 | (none — RED candidate) | (c) |
| `RECONCILER_RESUME_MAX_PER_HOUR` | 3 | T102 | (c) |
| `RECONCILER_LOOP_INTERVAL` | 60 | (none — RED candidate) | (c) |
| `RECONCILER_SLEEP_DIGEST_MAX_LINES` | 10 | (none — RED candidate) | (c) |
| `RECONCILE_SHADOW_LOG` | `$STATE_DIR/reconcile-shadow.jsonl` | T29 T63 | (c) |
| `ORCHESTRATOR_SID` | `orchestrator` | T102 asserts `--from orchestrator` | (c) |
| `ORCH_STALE_ALERT_MIN` | 5 | T98 | (c) |
| `AIGENTRY_SURFACE_ORPHANED_SOURCE` / `_MISMATCHED_SOURCE` | `$STATE_DIR/surface-*.jsonl` | T26 T95 | (c) |
| `AIGENTRY_CMUX_ORPHAN_LEDGER` | `$STATE_DIR/cmux-orphan-ledger.json` | prune-status.sh | **exported today** (:58) → must stay exported for the `wh-cli.sh` child |
| `AIGENTRY_BUS_BRIDGE` | `1` | `tests/dispatch/lib.sh` sets `0` | (c) gate |
| `AIGENTRY_HOST_POWER_STATE` | unset | T103 | **exported by this tick** (:908) for the tracker child; also short-circuits `platform::host_power_state` |
| `AIGENTRY_SLEEP_TELEMETRY_QUEUE` / `AIGENTRY_SLEEP_RESUME_MARKER` | `$STATE_DIR/…` | T102 T103 | (c) |
| `AIGENTRY_IOREG` / `AIGENTRY_PMSET` / `PLATFORM_OVERRIDE` | — | T103 | consumed **inside** `platform.sh` — inherited through the `bash -c` door |
| `AIGENTRY_ROLE_SANDBOX_DIR` / `AIGENTRY_WORKSPACE_HOST` / `CMUX_WORKSPACE_ID` | — | T102 T103, prune-status.sh | consumed **inside** `workspace-host.sh` — inherited through `wh-cli.sh` |
| `HOME` | passwd-db recovery | prune-status.sh:171 | **stays in the shim** (§3) |
| `PATH` | hardened `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH` | T90 depends on it shadowing stubs | **stays in the shim** (§3) |

## 5. Entrypoint contract (byte-identical)

Argv: `--dry-run`, `--shadow`, `--loop`, `--once` (no-op alias), `-h`/`--help`;
unknown flag → `unknown: <arg>` on stderr then usage, **exit 4**; `--help` →
usage, exit 0. Order-independent, repeatable, all four booleans accumulate.
Live entrypoint measured: `~/Library/LaunchAgents/com.aigentry.reconciler.plist`
= `/bin/bash <repo>/bin/session-reconciler.sh --loop`, `KeepAlive`, `RunAtLoad`,
`PATH` set, **no `HOME`**. `bin/install-launchd.sh` only bootstraps the label; it
does not write the plist, so **no installer change**. `--loop` re-execs
`"$0" --once` per interval (fresh process per tick); in TS this becomes a fresh
`node <cli.js> --once` child — same property, same `|| log` non-fatal arm.
Exit 0 on `abort sweep — bad telepty list` (:966) is preserved.

`bin/init/manifest.mjs:50` already ships `bin/session-reconciler.sh`; the file
keeps its path and stays a bin file, so **no manifest change**.

## 6. Platform branches

**Zero `process.platform` branches planned.** The bash file has no `uname` /
`case $(os_type)` arm of its own — enumerated candidates and where each one
actually lives: `host_power_state` (pmset, macOS) → `platform.sh`; `lid_closed`
(ioreg / `/proc/acpi/button/lid`) → `platform.sh`; `session_pid` (`ps -eo
pid,command`, same columns on BSD and GNU) → `platform.sh`; `kill -0` → POSIX;
`launchd` vs `systemd` → outside the file entirely. Rule 26 holds without a
branch to name, same as T1/T1b/T2a.

## 7. sw904 collision (Rule 36, disclosed)

`fix/904-report-sweep` adds one line after the tracker `check` block:
`"$TRACKER_SH" report-sweep` behind an `AIGENTRY_REPORT_SWEEP=0` opt-out. Not
blocking on it. If sw904 lands first, the step is ported into the TS tick with
the same opt-out env; if T2c lands first, sw904 adds it to the TS. The REPORT
says which happened.

## 8. HARD constraints acknowledged

Worktree only (`~/.aigentry/worktrees/rc899`, `feat/899-t2c-reconciler-ts`). The
live reconciler runs every 60s from launchd against the **main checkout** and the
production daemon on :3848 — launchd is never re-pointed, `launchctl` is never
run, and the port is never executed with `DRY_RUN=0` against the real state dir.
Tests use a temp state dir + recorder seams, exactly as the 13 invoking guards
already do. `bin/hitl.sh` is **not** ported (T2d) and `bin/lib/workspace-host.sh`
stays bash (#899's last item).
