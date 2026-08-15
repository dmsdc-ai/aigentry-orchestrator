# SPEC — cmux Adaptor: Auto-Prune Orphans + Status Push

- Date: 2026-06-06 · Author session: `adpt-coder-cmux-adaptor` (coder)
- Trigger: Architecture directive — the orchestrator's per-terminal **adaptor**
  (`bin/lib/workspace-host.sh`) must COMPREHENSIVELY keep its terminal's sidebar
  accurate AUTONOMOUSLY. Dead-session workspaces currently LINGER (nothing
  auto-prunes; orchestrator ran `close-workspace` by hand). No live status push.
- Mandate: SPEC FIRST (Rule 24) — this doc only, **no code until approved**.
- Scope (Rule 29): `bin/lib/workspace-host.sh` + `bin/session-reconciler.sh` ONLY.
  No cmux/telepty repo changes (cmux already exposes every needed primitive).
- ADR alignment: 2026-05-30 surface-ownership — **orchestrator adaptor = policy +
  actuation**, **cmux = primitive**, **telepty = signal/GC**. wh_* generic seam
  (Constitution §2) so swapping terminals swaps the adapter; headless = no-op (§17).
- Article 1 caps: SPEC ≤ 300 lines · impl Δ ≤ ~180 LOC · tests ≤ ~150 LOC.

---

## 0. Phase-1 investigation findings (verified live, read-only)

| # | Finding | Evidence |
|---|---------|----------|
| F1 | telepty `cmuxWorkspaceId` is a **UUID** (`A22AED3B-…`), not a `workspace:N` ref. | `telepty list --json` |
| F2 | cmux JSON requires the **GLOBAL** flag *before* the command: `cmux --json list-workspaces`. `list-workspaces --json` (flag after) prints the human text format → not JSON. | tested both |
| F3 | Workspace JSON shape is `{"workspaces":[{ref,title,current_directory,index,selected,pinned,custom_color}], "window_ref"}`. There is **NO `id`/UUID field** even with `--id-format both`. | tested |
| F4 | Worker workspace **`title` == telepty session id** (`adpt-coder-cmux-adaptor`, `diag-analyst-reconciler`). Orchestrator title is decorated (`⚡ orchestrator \| ✳ …`) — protected anyway. | listing |
| F5 | aigentry-spawned worker workspaces have `current_directory` under `~/.aigentry/role-sandbox/` (ownership signal). Orchestrator cwd = `projects/aigentry-orchestrator`. | listing |
| F6 | `close-workspace`, `set-status`, `list-status`, `sidebar-state` all accept `--workspace <UUID>` (UUID works as a handle even though listing never prints it). | tested |
| F7 | `sidebar-state --workspace <UUID>` is the only per-UUID liveness probe, BUT it **exits 0 even for a missing tab** — prints `Error: ERROR: Tab not found` on stdout. Liveness MUST be judged by stdout content, not exit code. | tested |
| F8 | claude_code already owns a sidebar pill: `list-status` shows `claude_code=Running icon=bolt.fill color=#4C8DFF`. aigentry MUST use a **distinct key** (set-status help: "use a unique key"). | tested |
| **F9 (BUG)** | Existing `_wh_cmux_alive` / `_wh_cmux_list_ids` do `cmux list-workspaces --json \| jq '.[].id'` — wrong on 3 counts (F2 flag placement, F3 path `.workspaces[].ref` not `.[].id`, F3 no UUID in listing). They **never return a real result**: `wh_alive` always reports "gone"; `wh_list_ids` always empty. Today this is masked (sweep gates `surface_gone` as INV-17 single-signal skip; `wh_close` re-probe always says "gone" → close returns 0). | code + tests |

**F9 decision point (Rule 29):** prune needs a working cmux listing, so correcting
the JSON invocation is *traceable to this request*. I propose to **fix F9 as part of
Phase 2** (minimal: correct flag placement + jq path; switch UUID-liveness to the
F7 `sidebar-state` stdout probe). This is the surgical-vs-scope fork → flagged in the
HOLD inject for orchestrator approval before any edit.

---

## 1. Deliverables

| ID | Artifact | Purpose |
|----|----------|---------|
| A | `wh_prune_orphans <live_ids_csv> <protected_csv>` (workspace-host.sh) | Close cmux workspaces whose session is gone from telepty, gated. |
| B | `wh_set_status <host_id> <state>` (workspace-host.sh) | Map telepty state → cmux sidebar pill (+progress). |
| C | F9 fix: corrected `_wh_cmux_alive` / `_wh_cmux_list_ids` + new `_wh_cmux_list_titles` helper | Make the cmux listing actually parse (pending §0 approval). |
| D | `session-reconciler.sh` wiring (step 2) | Call A; call B per live session. Pass live/protected sets. |
| E | Reconciler reactivation — **KeepAlive daemon conversion** | Durable un-dormant: `StartInterval` → `KeepAlive` long-running loop (analyst root-cause). |
| F | `tests/workspace-host/*.sh` | Throwaway-workspace + mocked-cmux coverage. |

---

## 2. §A — Auto-prune (the lingering-workspace fix)

### 2.1 Detection (title-based diff — the only reliable cmux correlation, per F1–F3)

The gap: telepty has already **dropped** the dead session, so there is no telepty
entry to drive the existing telepty-side sweep. Prune therefore iterates the **cmux**
side and finds workspaces with no matching live session:

```
orphan_candidate(W) :=  W.title ∉ live_ids                      # no live session
                    AND owned(W)                                # aigentry-spawned
                    AND W.ref ∉ protected_refs                  # never orchestrator
```

`owned(W) :=` `W.current_directory` is under `~/.aigentry/role-sandbox/`
**OR** `W.title` matches a known former sid in `state/dispatch/active.json`.
This prevents pruning a user's hand-opened workspace (Constitution §1: do only our job).

### 2.2 Gate — INV-17-style corroboration (never prune a live / just-spawning session)

Two independent guards before any close:

1. **Liveness corroboration (caller-supplied set).** `live_ids` is the reconciler's
   `gc_root ∪ keep_alive ∪ telepty-ids` (all currently-live sids). A title in that
   set is never pruned. `protected_refs` includes the orchestrator workspace ref
   (resolved from `$CMUX_WORKSPACE_ID` / the decorated-title workspace).
2. **Seen-twice debounce (spawn-race floor, replaces the missing creation timestamp).**
   cmux workspace JSON carries **no creation time** (F3), so the reconciler's usual
   `age > 300s` floor can't apply directly. Instead the adapter keeps a tiny ledger
   `state/dispatch/cmux-orphan-ledger.json` (`{ ref: first_seen_iso }`). A candidate
   is closed **only if it was ALSO a candidate on the previous tick** (persisted ≥1
   tick ≈ ≥60s). First sighting → record + skip. This mirrors the existing
   `disconnect_age` floor and guarantees a freshly-spawned workspace (title set
   before telepty registers it) survives at least one reconcile cycle.

Cleared entries (no longer candidates, or successfully closed) are pruned from the ledger.

### 2.3 Where it runs

`session-reconciler.sh` **step 2** (orphan sweep), after `gc_root`/`keep_alive` are
computed and after the existing telepty-side candidate loop. `--dry-run` logs
`PRUNE would-close ref=… title=…` and does not act, does not advance the ledger past
recording. Backoff: reuse close idempotency (F6) + the seen-twice ledger; no new
backoff file. Honors `DRY_RUN`.

---

## 3. §B — Status push (live per-session sidebar status)

### 3.1 telepty state → cmux mapping

Derive `state` from telepty `healthStatus` (+ optional activity probe later):

| telepty signal | `state` | cmux actuation (key `aigentry`, F8) |
|----------------|---------|--------------------------------------|
| CONNECTED + working/active | `working` | `set-status aigentry "working" --icon hammer --color "#ff9500"` |
| CONNECTED + idle | `idle` | `set-status aigentry "idle" --icon checkmark --color "#34c759"` |
| DISCONNECTED | `disconnected` | `set-status aigentry "disconnected" --icon exclamationmark --color "#ff3b30"` |
| (session cleaned up) | — | `clear-status aigentry` (on prune/cleanup) |

- **Distinct key `aigentry`** so we never clobber claude_code's `claude_code` pill (F8).
- `set-progress` is **optional / deferred**: only emit when a numeric progress is
  available; Phase-2 mapping uses set-status only (Article 1 — no speculative wiring).
- `working` vs `idle` discrimination: Phase 2 uses the reconciler's existing
  `session-probe.py` activity field where available; absent that, default
  CONNECTED → `idle` (conservative; never shows false "working").

### 3.2 Cadence

Reconciler **tick** (60s), inside step 2, iterating the live telepty listing it already
fetched (`listing`). One `wh_set_status <cmuxWorkspaceId> <state>` per live session.
Event-driven push is a later option (the dormant `surface_*` bus→file bridge could
carry state too) — **out of scope** here (§1 minimalism).

---

## 4. §C — Adaptor surface (new + corrected functions)

All cmux-specific knowledge stays behind the generic `wh_*` seam; **headless = no-op**;
**warp = no-op for now** (Warp has no status CLI — degrade per §17).

```
wh_prune_orphans <live_ids_csv> <protected_refs_csv>   # → prints count closed; 0 always
wh_set_status   <host_id> <state>                      # state ∈ {working,idle,disconnected}; 0 always
wh_clear_status <host_id>                              # idempotent
```

cmux-adapter internals (private `_wh_cmux_*`):

- `_wh_cmux_list_titles` — `cmux --json list-workspaces | jq -r '.workspaces[] | [.ref,.title,.current_directory] | @tsv'` (F2/F3 correct shape).
- `_wh_cmux_prune_orphans` — implements §2 (diff + owned + ledger + close via existing `_wh_cmux_close`).
- `_wh_cmux_set_status` — `cmux set-status aigentry "<state>" --icon … --color … --workspace <host_id>`.
- `_wh_cmux_alive` (F9 fix) — `cmux sidebar-state --workspace <host_id>`; alive iff stdout is non-empty AND does not start with `Error:` (F7).
- `_wh_cmux_list_ids` (F9 fix) — kept for API compatibility but documented as
  ref-based (titles are the correlation key); `wh_list_ids` semantics unchanged for
  callers (still "host_ids the adapter knows" = refs).

Headless/warp adapters gain matching `_wh_{headless,warp}_{prune_orphans,set_status,clear_status}` no-ops returning 0 (contract symmetry, §17). Existing 5-method contract is preserved; these are additive.

---

## 5. §D/§E — Reconciler wiring + reactivation

- **§D wiring (workspace-host.sh already sourced at line 74).** In step 2:
  - After `gc_root`/`keep_alive` computed: build `live_ids = telepty-ids ∪ gc_root ∪ keep_alive`; resolve `protected_refs` (orchestrator). Call `wh_prune_orphans "$live_ids" "$protected_refs"` (skip when `DRY_RUN=1` → pass through to the function's dry log).
  - Inside the existing live-listing iteration, call `wh_set_status "$cmuxWorkspaceId" "$state"` per CONNECTED/DISCONNECTED session.
  - Both are **best-effort, never block the sweep** (functions always return 0, §17).
- **§E reactivation (DEPENDENCY).** The launchd job `com.aigentry.reconciler`
  (`~/Library/LaunchAgents/com.aigentry.reconciler.plist`, `--once`, `StartInterval`
  60, `RunAtLoad`) drives the tick. The dispatch reports it DORMANT (last act-tick
  2026-05-31). **NOTE:** I observed `state/dispatch/reconciler.log` ticks dated
  2026-06-06 but all `dry_run=1` — i.e. manual `--dry-run` runs, not the launchd act
  path; consistent with the launchd job being down. **The parallel analyst session
  owns the root-cause + exact reactivation steps** (likely `launchctl
  bootout/bootstrap` or `kickstart`); Phase 2 applies their finding. I will **not**
  edit the plist or run `launchctl` without the analyst's confirmed procedure
  (HOLD/escalate if it needs a plist change I'm unsure of — boundary §92).

---

## 6. Test approach (NEVER risk a live session)

The author session runs **outside** cmux-as-target; tests use **throwaway
workspaces only** and never touch any sid in the live telepty listing.

1. **Prune (throwaway).** `cmux new-workspace --cwd <tmp under role-sandbox>` →
   rename-workspace to a fake sid `zz-throwaway-<n>` → confirm via `wh_prune_orphans`
   with `live_ids` that **excludes** the fake sid: first call records ledger + does NOT
   close (seen-once); second call closes it. Assert `cmux --json list-workspaces` no
   longer lists it. Verify a fake sid placed *in* `live_ids` is never closed; verify a
   workspace whose cwd is NOT under role-sandbox is never closed (ownership gate).
2. **Status (throwaway).** `wh_set_status <throwaway_uuid> working` → `list-status`
   shows `aigentry=working`; `wh_clear_status` removes it; assert claude_code's own
   pill is untouched.
3. **F9 alive.** `wh_alive <live_uuid>` → 0; `wh_alive <bogus_uuid>` → 1 (stdout
   `Error:` parsing, F7).
4. **Adapter isolation.** `AIGENTRY_WORKSPACE_HOST=headless` → all new fns no-op
   return 0 (CI safety).
5. `bash -n` on both files. No Snyk (shell not Snyk-scanned; Phase 2 touches no
   `.py/.ts/.js`).

**Hard boundary:** never call `wh_prune_orphans` with a `live_ids` set that omits a
*real* session; the throwaway sid prefix `zz-throwaway-` + cwd sandbox guard keep the
blast radius to workspaces this test created. No cmux DEV build (reflexivity hazard).

---

## 7. Open questions for orchestrator (resolve at approval)

1. **F9 scope (Rule 29):** OK to fix the broken cmux JSON probe as part of Phase 2
   (required for prune to function), or split to a separate task?
2. **§E reactivation:** confirm the analyst's reactivation procedure before I touch
   launchd (I will not edit the plist unilaterally).
3. **working/idle source:** accept the conservative default (CONNECTED→idle unless
   `session-probe.py` reports activity), or wire a richer activity signal now?
```
