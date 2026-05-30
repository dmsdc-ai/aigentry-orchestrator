---
type: adr
status: decided
date: 2026-05-30
supersedes_clause: docs/adr/2026-05-29-telepty-lifecycle-gc-surface-focus.md §3 (#30 close=telepty)
topic: terminal-surface lifecycle ownership (orchestrator workspace-host adapter)
---

# VERDICT: Terminal-Surface Lifecycle Ownership

**ADR addendum — boundary ruling + rework plan**
**Date:** 2026-05-30
**Status:** DECIDED (supersedes the §3 `#30 close = telepty` ownership clause of `docs/adr/2026-05-29-telepty-lifecycle-gc-surface-focus.md`)
**Decision owner:** orchestrator (control tower)
**Inputs:** telepty-owns advocacy memo, orchestrator-owns advocacy memo, neutral audit; verified against live code at telepty HEAD + working tree, `CONSTITUTION.md`, `CONTEXT.md`, `BOUNDARY.md`, ADRs 2026-05-27 / 2026-05-29.

---

## 0. TL;DR

**The orchestrator's `bin/lib/workspace-host.sh` adapter seam owns terminal-surface lifecycle (spawn / close / focus / alive-probe-as-policy-input). telepty owns session + PTY lifecycle, and emits a structured surface-orphan *signal* — it does not actuate surface close.**

Concretely:
- **telepty KEEPS:** session/PTY teardown, the `isSurfaceAlive` *read-only probe*, and a NEW `surface_orphaned` bus event. **telepty's session-GC stays** (reclaim the headless zombie *session*), but the **surface-close actuation is removed** from the daemon.
- **telepty REVERTS (working-tree only — not yet committed):** `closeSurface()` actuation calls at `daemon.js:1358` and `daemon.js:2695`; `focusSurface()` actuation wiring; the `cmux close-workspace` and `cmux select-workspace` execFileSync calls in `terminal-backend.js`.
- **orchestrator GAINS:** a NEW `warp` adapter in `workspace-host.sh` alongside `cmux`/`headless`; surface-close + focus-policy ownership; the reconciler consumes telepty's `surface_orphaned` event.
- **Standalone-telepty (§9):** resolved by the *session*-GC staying in telepty (no zombie session leak) + a documented, narrow `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1` opt-in fallback for the orchestrator-absent case — **off by default**, never the managed-path default.
- **INV-17 (#486 non-regression):** PRESERVED. The `'unknown'`-on-cmux-unreachable gate moves with the probe; the orchestrator's reconciler already has GC-root + age-floor + backoff, so the kill decision is *corroborated*, never single-signal.

This is the constitutionally correct boundary and it is **cheap to adopt now** because the #30/#31 surface-actuation code is uncommitted working-tree state (see §9). §5 best-first: do it before it lands.

---

## 1. The boundary, stated once

| Concern | Owner | Mechanism |
|---|---|---|
| Session existence (register/teardown/persist) | **telepty** | daemon session table |
| PTY lifecycle (spawn/resize/kill) | **telepty** | `terminalBackend` PTY ops |
| stdin/stdout multiplexing (`send`, `send-key`) | **telepty** | `cmuxSendText` — *driving* an existing surface |
| Surface-liveness **probe** (read-only) | **telepty** | `isSurfaceAlive` → `'alive'\|'gone'\|'unknown'` |
| Surface-orphan **signal** | **telepty** | NEW `surface_orphaned` bus event |
| Session-GC of a headless zombie *session* | **telepty** | SURFACE-GC loop reclaims the **session** (closes ownerWs, deletes entry) — **does not close the surface** |
| Surface **spawn** (`cmux new-workspace`) | **orchestrator** | `bin/open-session.sh:176` (already true) |
| Surface **close** (`cmux close-workspace`) | **orchestrator** | `workspace-host.sh` `wh_close` |
| Surface **focus** policy + actuation | **orchestrator** | NEW `wh_focus` in `workspace-host.sh` |
| Surface adapter selection (cmux/warp/headless) | **orchestrator** | `_wh_adapter` dispatch |
| Cross-component reconciliation sweep | **orchestrator** | `bin/session-reconciler.sh` (GC root = dispatch registry) |

The dividing line is **drive vs. own-existence**. Writing bytes *into* a surface (`send`/`send-key`) is nervous-system work — telepty's role (§3 "세션/머신/OS 연결"). Deciding the surface should *cease to exist* (`close-workspace`) or *come to the foreground* (`select-workspace`) is lifecycle control of a UI container the orchestrator created — the conductor's call. The "symmetric with `cmuxSendText`" rebuttal in ADR 2026-05-29 §3 conflates these two; this verdict rejects that conflation.

---

## 2. Rationale (§3 / §9 / §17, weighed against every counter)

### §3 (역할) — decisive for orchestrator-owns

`CONSTITUTION.md:57` lists telepty's "절대 하지 않는 것" as **"UI 렌더링, 기억 저장."** A cmux/Warp *workspace* is a visible UI surface; `close-workspace`/`select-workspace` are UI-surface lifecycle actions. ADR 2026-05-27 §1 draws the same line verbatim: *"cmux is a visible UI container and telepty is a session daemon + supervised PTY — distinct roles."*

`CONTEXT.md:11-13` encodes the split as a first-class domain term (**Workspace Host**, "accessed via adapter"), and `CONTEXT.md:60` records the Session↔cmux-workspace conflation as **already resolved**: *"a Session is the telepty-registered context, a Workspace Host is a separate concern accessed via adapter."* Putting `closeSurface(session)` inside telepty — which reaches from a `session` into its `.cmuxWorkspaceId` to destroy a tab (`terminal-backend.js:174-177`) — **re-introduces the exact conflation the domain model marks resolved**, now in a second repo.

The telepty-owns memo's strongest §3 reply is "data locality" (Arg 1): telepty already *stores* `cmuxWorkspaceId`, so it should *act* on it. **Rebuttal:** storing an ID for *probing* (read) does not imply ownership of *actuation* (destroy). The orchestrator's `wh_lookup` (`workspace-host.sh:45-52`) already reads that same field cleanly through the public `telepty list --json` contract — no cross-component reach-in, no private-field coupling. Data locality argues for telepty owning the *probe* (which this verdict grants), not the *close*.

### §9 (독립) — the one place orchestrator-owns must yield, and how it does

This is the telepty-owns memo's strongest argument (Arg 2) and the neutral audit's decisive signal: `CONSTITUTION.md:132` says *"telepty는 orchestrator 없이도 동작한다,"* and `BOUNDARY.md:9` claims *"Session lifecycle: track active sessions, clean up on exit or owner disconnect"* as telepty-owned. A standalone telepty that never closes its surface leaks ghost tabs.

**This verdict satisfies §9 without giving telepty surface-close-by-default, by separating two leaks that the #30 design fused:**

1. **Zombie *session* leak** (CONNECTED-but-headless session record accumulating, never reclaimed). This is the real §9/§17-PARTIAL harm in ADR 2026-05-29 §1. **Fix stays in telepty:** the SURFACE-GC loop (`daemon.js:3255-3277`) keeps reclaiming the *session* — closing `ownerWs`, deleting the entry, persisting. This is teardown of telepty's *own* in-memory state, squarely BOUNDARY.md:9. **No surface command is issued.**

2. **Ghost *surface* leak** (an orphaned cmux tab with nothing inside). In the **managed** case this is the orchestrator's reconciler job (it spawned the surface). In the **unmanaged standalone** case, telepty gets a **documented opt-in**: `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1`, **off by default**, which re-enables a single guarded `closeSurface` on destroy. This is the gate ADR 2026-05-29 §3.3 OQ-3 *named* but wrongly recommended shipping as the default — this verdict flips the default per the orchestrator-owns memo O1.

Why this is correct and not a fudge: the §9 invariant is *"telepty works standalone,"* not *"telepty closes UI surfaces by default."* A standalone telepty with the opt-in unset still works — it leaks at most a visual tab the user can close, while never leaking a zombie *session* (the actual resource/correctness harm). The managed path — the overwhelmingly common one — keeps surface lifecycle where the spawner is, honoring creator=destroyer symmetry (`open-session.sh:176` opens; `workspace-host.sh` closes).

**§9 also cuts *against* telepty-owns** (orchestrator-owns memo O4 / telepty-owns self-objection O4): `closeSurface`/`isSurfaceAlive` are cmux-only (`terminal-backend.js:147,175`). telepty-side surface ownership delivers §9 for **1 of 6 backends**. The orchestrator's adapter seam delivers it uniformly per-backend (cmux + headless today, **+ warp** under this verdict) — strictly better §9 coverage.

### §17 (무의존) — favors orchestrator-owns

`CONSTITUTION.md:223`: independence from external tools. `terminal-backend.js` hard-codes cmux as a daemon runtime dependency for *actuation* (`close-workspace` :179, `select-workspace` :200). ADR 2026-05-27 §2.3 already rejected option (b) on this exact ground: *"aigentry should not bake in cmux-specific recovery."* Baking cmux-specific *close/focus* into the daemon repeats that mistake. The orchestrator's adapter isolates the cmux dependency behind one seam with a `headless` no-op fallback (`workspace-host.sh:90-93,98-108`) — the designed home for "which frontend am I driving."

telepty retains exactly one cmux touchpoint after rework: the **read-only `isSurfaceAlive` probe**. Reading liveness is "OS 연결" (telepty's role); issuing destroy/focus commands is not.

### §1 (경량) + DRY — favors orchestrator-owns, and rebuts the neutral lean

The neutral audit leaned telepty-owns but conceded its core defect: **literal duplication**. `cmux close-workspace --workspace <id>` exists in **two repos** for the **same event** — `workspace-host.sh:60` and `terminal-backend.js:179` — producing a real **double-close** on the Layer-A/D path (`session-cleanup.sh` close + telepty DELETE close both fire). `CONSTITUTION.md:74` forbids this: *"중복 구현을 금지한다. Single source of truth."* The orchestrator adapter is the *more mature* of the two (4 methods incl. `wh_list_ids` host-orphan detection + `wh_alive` re-probe + headless adapter + reconciler integration). The simplest correct boundary (§1) keeps **one** close implementation; the redundant copy is the telepty one.

The neutral audit's reason for nonetheless leaning telepty ("#30 already shipped; ripping it out fails §1's *이거 없이 가능한가*") **rests on a factual error this verdict corrects: #30 has NOT shipped.** It is uncommitted working-tree state (§9 below). There is no landed code to rip out — only a diff to stage selectively. §1's "build the least machinery" gate therefore points the other way: do not commit a second close-path that duplicates the mature adapter.

### Why this is NOT a re-coupling of what #487 decoupled

ADR 2026-05-27 (#487) severed **surface-death → session-death** (cmux SIGHUP killing telepty sessions — committed, `08cd796`). A naive reading says "#30 adds the reverse, session-death → surface-death, that's fine / that's symmetric." The orchestrator-owns memo §5 shows the asymmetry is real but the *ownership* of the reverse edge is the question — and §3 answers it: the orchestrator (creator) owns surface destruction, telepty (session owner) signals "my session is gone." This verdict keeps the #487 decouple **and** routes the session→surface edge through the creator, so neither direction couples telepty's existence to a UI frontend's lifecycle. INV-17 / #486 non-regression is preserved by keeping the *probe* gated `'unknown'`-on-unreachable (§5 below).

---

## 3. EXACTLY what changes in telepty (file:line)

> All telepty changes below are to **uncommitted working-tree state** — see §9. This is "stage the correct subset," not "revert a commit."

### REVERT / RELOCATE (remove surface *actuation* from the daemon)

| File:line | Current (working tree) | Action |
|---|---|---|
| `terminal-backend.js:178-181` | `execFileSync('cmux', ['close-workspace', ...])` inside `closeSurface` | **REMOVE** the cmux-close actuation. `closeSurface` either deleted entirely, or kept as a **gated no-op** that only runs when `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1` (standalone fallback, §4). |
| `terminal-backend.js:199-210` | `select-workspace` + `focus-pane` execFileSync inside `focusSurface` | **REMOVE** focus actuation. Focus is orchestrator policy+mechanism (§4). |
| `daemon.js:1358` | `try { terminalBackend.closeSurface(session); } catch {}` in `teardownSessionById` | **REMOVE** (or guard behind the standalone opt-in). |
| `daemon.js:2695` | `try { terminalBackend.closeSurface(session); } catch {}` in DELETE handler | **REMOVE** (or guard behind the standalone opt-in). |
| `daemon.js:1666-1668` (focus wiring per memo) / register-handler focus opt-in | `focusSurface` invocation on register | **REMOVE** — focus policy moves to orchestrator. telepty no longer foregrounds surfaces. |
| `daemon.js:3262-3271` SURFACE-GC `reclaim` branch | calls `teardownSessionById(...)` which (today) calls `closeSurface` | **KEEP the session reclaim**, but it no longer transitively closes the surface (because `closeSurface` actuation is gone). Add the `surface_orphaned` emit (below). |

### KEEP (telepty's legitimate role)

| File:line | What | Why it stays |
|---|---|---|
| `terminal-backend.js:146-169` `isSurfaceAlive` | read-only `'alive'\|'gone'\|'unknown'` probe with INV-17 gate | Probing OS/surface liveness is "OS 연결" (§3). Read, not actuate. **INV-17 lives here — must not move into bash naively (§5).** |
| `daemon.js:38-46` `decideSurfaceGc` | pure verdict→action mapping | Drives *session* reclaim, not surface close. Unit-testable, stays. |
| `daemon.js:3255-3277` SURFACE-GC loop | reclaims headless-zombie **sessions** | Session-lifecycle cleanup = BOUNDARY.md:9. **This is what makes standalone-§9 work without telepty owning surface-close.** |
| `terminal-backend.js` `cmuxSendText`/`cmuxSendEnter` | stdin write into existing surface | *Driving* a surface = telepty's role. Untouched. |
| daemon.js `detectTerminal` | `cmux\|kitty\|headless` detection | Read-only capability detection. Untouched. |

### ADD (new in telepty)

- **`surface_orphaned` bus event** — emitted from the SURFACE-GC `'gone'`/`reclaim` path. Payload: `{ sid, backend, cmuxWorkspaceId, surfaceGoneSeconds, livenessVerdict }`. This is the **signal** the orchestrator reconciler consumes to decide surface-close. telepty signals; orchestrator actuates. (Mirrors BOUNDARY.md:8 "publish structured events" — telepty's sanctioned role.)
- **`AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE` opt-in guard** (default off) wrapping any retained standalone close path (§4).

### BOUNDARY.md fix (resolve the internal contradiction the audit surfaced)

`BOUNDARY.md:18,29` declare telepty an in-memory **"stateless dumb pipe"** that *"does not interpret, retry, sequence."* The working-tree SURFACE-GC adds `surfaceGoneAt` grace-window **state** + a cmux **inventory query** — contradicting telepty's own charter. Resolve by adding to BOUNDARY.md "What telepty does NOT own": **"Terminal-surface lifecycle (open/close/focus of cmux/warp workspaces) — belongs to the Workspace Host adapter in the orchestration layer. telepty probes surface liveness (read-only) and emits `surface_orphaned`; it does not close or focus surfaces."** Keep line 9 but scope it: "clean up *sessions* on exit/disconnect" (not surfaces).

---

## 4. What the orchestrator's `workspace-host.sh` owns (incl. the NEW warp adapter)

### Stays / strengthens (already present)

- 4-method contract `wh_lookup` / `wh_close` / `wh_alive` / `wh_list_ids` (`workspace-host.sh:12-32`) — unchanged, the single source of truth for surface close.
- `_wh_cmux_close` (`:54-68`) with re-probe-confirms-already-closed idempotency — the **one** `cmux close-workspace` implementation.
- `headless` no-op adapter (`:90-93`) — §17 graceful degrade.
- `_wh_adapter` env-override→auto-detect dispatch (`:98-108`).
- Consumed by `session-cleanup.sh` (Layer A/D) and `session-reconciler.sh` (sweep). The **double-close is eliminated** because telepty no longer closes.

### NEW: `warp` adapter (this verdict's explicit requirement)

The Warp auto-manage adapter belongs in `workspace-host.sh`, **not** `terminal-backend.js`. Add alongside cmux/headless — four functions implementing the same contract:

```
_wh_warp_lookup()    # map sid → warp surface id (via telepty list .warpSurfaceId, or warp CLI)
_wh_warp_close()     # warp CLI close; idempotent (already-gone → 0); cmd-not-found → 0 (§17 degrade)
_wh_warp_alive()     # warp CLI liveness probe → 0 alive / 1 gone
_wh_warp_list_ids()  # enumerate warp-known surface ids (host-orphan detection)
```

And extend `_wh_adapter` selection: `AIGENTRY_WORKSPACE_HOST=warp` force, plus auto-detect (`command -v warp`). Same shape as cmux — proving the boundary is right: adding a 6th backend touches **one** file in **one** repo, never the daemon. (If telepty owned surface-close, Warp support would require a second cmux-shaped block inside `terminal-backend.js` — exactly the §17 coupling we are removing.)

### NEW: focus policy + mechanism

Focus moves wholesale to the orchestrator (resolving telepty-owns self-objection O2 + neutral O2): add `wh_focus <host_id>` to the contract + per-adapter `_wh_{cmux,warp,headless}_focus`. The spawner (`open-session.sh`/`dispatch.sh`) decides *when* (the opt-in policy) and calls `wh_focus`. Note ADR 2026-05-29 §4.3 OQ-4: focus efficacy for the codex "Starting MCP servers" hang is **unproven** — so wire focus as spawn-time-foregrounding only, behind an opt-in flag, and treat the codex-unblock hypothesis as separately-gated (do not let an unproven trigger justify daemon-side focus).

---

## 5. telepty#17 split + INV-17 (#486 non-regression) preservation

#17 ("PARTIAL — surviving bridge → headless zombie") splits cleanly along the boundary:

| #17 sub-concern | Owner | Where |
|---|---|---|
| **Detect** surface gone (read-only) | telepty | `isSurfaceAlive` probe — **stays**, INV-17 gate intact |
| **Reclaim the zombie *session*** | telepty | SURFACE-GC loop reclaims session record — **stays** (this is what closes the §9 zombie-session leak) |
| **Signal** the orphan upward | telepty | NEW `surface_orphaned` bus event — **added** |
| **Close the orphan *surface*** | orchestrator | reconciler consumes `surface_orphaned` (or its own `wh_alive` sweep) → `wh_close` — **relocated here** |

**INV-17 / #486 non-regression — PRESERVED, two layers of defense:**

1. The `'unknown'`-on-cmux-unreachable gate **stays in `isSurfaceAlive`** (`terminal-backend.js:150-165`). A cmux app-quit/restart vanishes *all* surfaces at once → probe returns `'unknown'` → `decideSurfaceGc` → `'skip'` → **GC nothing**. This is the #486/#488 mass-kill guard and it must not be reimplemented naively in bash (the orchestrator-owns memo §5 correctly warns that a naive bash version mass-kills on cmux restart).

2. The orchestrator's reconciler **already** has GC-root (dispatch registry) + age-floor + backoff (`session-reconciler.sh`), so surface-close is **corroborated by multiple signals** (PID-dead, disconnect-age, `wh_alive`, telepty's `surface_orphaned`) — never a single-signal kill. Two independent gates (telepty's probe-side `'unknown'` + orchestrator's GC-root corroboration) make #486 regression strictly *harder* than the #30 design, which gated only on the probe.

The TOCTOU concern the telepty-owns memo raises (Arg 3 — "cmux dies between orchestrator's read and close, re-creating #486") is handled: the orchestrator never closes on a single read; `_wh_cmux_close` itself re-probes (`workspace-host.sh:63-66`), and a cmux that died mid-sweep makes `wh_close` a `cmd-not-found`/`already-gone` no-op (`:57`). No mass-kill path exists.

---

## 6. Standalone-telepty resolution (the §9 crux, settled)

**Default (managed, common case):** orchestrator owns surface close. No telepty surface actuation. Creator=destroyer holds.

**Standalone (orchestrator-absent):**
- **Zombie *session* leak: fully fixed in telepty** by the retained SURFACE-GC session-reclaim. A standalone `telepty kill <sid>` or CLI-exit reclaims the session record — no accumulation. §9 correctness harm eliminated *without* surface ownership.
- **Ghost *surface* (visual tab) leak:** fixed by opt-in `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1` (default off). Standalone users who want self-tab-cleanup set it; the managed orchestrator never sets it (so no double-close, no managed-path surface authority in telepty).

This directly answers telepty-owns Arg 2 and the neutral lean: §9 demands telepty *function* standalone (✓ — session GC) and *deliver value single-installed* (✓ — opt-in tab cleanup available), **not** that telepty own surface-close on the managed path. The neutral lean's own recommended end-state ("demote `wh_close` to a reconciler-only backstop") is **rejected** as backwards: it would make the *immature, duplicated, cmux-only* telepty path primary and the *mature, multi-backend, single-source* adapter the backstop — violating §1/DRY/§17. This verdict inverts that: orchestrator adapter primary, telepty opt-in fallback.

---

## 7. ADR addenda needed

1. **`docs/adr/2026-05-29-telepty-lifecycle-gc-surface-focus.md` — addendum (this verdict).** Supersede the §3 clause "#30 close = telepty daemon + adapter … telepty owning its own end-to-end." Replace with: "#30 close = orchestrator Workspace Host adapter; telepty emits `surface_orphaned`, reclaims the *session*, and probes liveness only. The 'symmetric with cmuxSendText' justification is withdrawn — drive ≠ own-existence." Flip OQ-3 default (managed path does NOT self-close in telepty). Record OQ-4 focus efficacy as still-open and move focus policy to orchestrator.
2. **`docs/adr/2026-05-20-*` (Workspace Host adapter ADR) — addendum.** Add the `warp` adapter to the contract; declare `workspace-host.sh` the single source of truth for surface close+focus across all backends; add `wh_focus`.
3. **`aigentry-telepty/BOUNDARY.md` — edit (§3 above).** Add "Terminal-surface lifecycle" to "does NOT own"; scope line 9 to *sessions*.
4. **`CONTEXT.md` — `decision_review_log` append + glossary.** CLDR trigger (c): external-perspective adjudication revealed the #30 design re-introduced the `CONTEXT.md:60` resolved conflation. Append `{date: 2026-05-30, trigger: "tri-perspective boundary audit", finding: "#30 closeSurface re-coupled Session→Workspace-Host actuation in telepty, duplicating the mature workspace-host.sh adapter and contradicting BOUNDARY.md dumb-pipe charter", context_correction: "surface close/focus = orchestrator adapter; telepty = probe+signal+session-GC only", downstream_action: "stage telepty diff selectively; add warp adapter; addenda to 2 ADRs + BOUNDARY.md"}`. Add glossary line clarifying `surface_orphaned` event + telepty-probes/orchestrator-actuates split.
5. **`aigentry/docs/CONSTITUTION.md`** — no amendment needed; this verdict *applies* §3/§9/§17 as written.

---

## 8. Positive end-state design (one diagram in prose)

```
SPAWN:    orchestrator open-session.sh → `cmux/warp new-workspace` → `telepty allow` runs INSIDE
          (creator = orchestrator)                                     (telepty owns the PTY/session inside)

DRIVE:    orchestrator/worker → `telepty inject` → telepty cmuxSendText → bytes into surface
          (telepty drives the surface — its role)

EXIT:     CLI exits → telepty DELETE → telepty: close ownerWs, delete session, persist, EMIT surface_orphaned
          → orchestrator session-cleanup.sh / reconciler consumes → wh_close (cmux|warp|headless adapter)
          (telepty owns session teardown + signal; orchestrator owns surface close — creator=destroyer)

CRASH:    surface vanishes → telepty isSurfaceAlive='gone' (or 'unknown'→PRESERVE per INV-17)
          → telepty reclaims zombie SESSION + emits surface_orphaned
          → orchestrator reconciler corroborates (GC-root + age + wh_alive) → wh_close
          (two-gate #486 safety)

STANDALONE (no orchestrator): telepty session-GC still reclaims sessions (§9 ✓);
          optional AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 closes the tab (default off).
```

telepty stays a frontend-agnostic PTY/session multiplexer + signal emitter. The cmux/warp dependency lives in exactly one place — the orchestrator's adapter. Single source of truth, creator=destroyer, §3/§9/§17 all satisfied.

---

## 9. Safe sequencing (verify current work first, then rework — §5 best-first)

**Verified pre-condition (decisive):** the #30/#31 surface-*actuation* code is **uncommitted working-tree state** in `aigentry-telepty`. Confirmed: `terminal-backend.js` is tracked but its committed HEAD contains **zero** of `closeSurface`/`focusSurface`/`isSurfaceAlive` (all 3 are in the +97-line working-tree diff); `daemon.js` working-tree diff has 21 hunks touching `closeSurface`/`SURFACE-GC`/`isSurfaceAlive`/`focusSurface`/`surfaceGoneAt`/`decideSurfaceGc`. Only the #488 SIGHUP-decouple (`08cd796`) and v0.4.5 bundle are committed. **The rework is staging the correct subset of an uncommitted diff — not reverting a published release.** This is the cheapest possible moment to correct the boundary (§5: right architecture before it lands).

**Sequence (delegated, not done by orchestrator — Rule 4/13):**

1. **HOLD / freeze.** Do NOT `git commit` or `npm publish` the telepty working tree as-is. The committed-and-published cost of the wrong boundary is the publish→sibling-propagation blast radius; avoid it.
2. **Verify current state (analyst/tester session, read-only).** Confirm: (a) #488 SIGHUP decouple commit `08cd796` is correct and stays; (b) catalog the working-tree diff into KEEP vs REMOVE per §3's table; (c) run the existing surface-GC unit tests against `decideSurfaceGc` to confirm session-reclaim behavior is independent of `closeSurface` (it is — `decideSurfaceGc` returns a verdict; the close was a separate call).
3. **Rework telepty (telepty session, coder).** Stage KEEP set (probe + session-GC + `decideSurfaceGc`), drop REMOVE set (close/focus actuation + their call-sites + focus wiring), add `surface_orphaned` emit + the standalone opt-in guard, edit BOUNDARY.md. Snyk scan the JS diff (CLAUDE.md global). Commit as one surgical change (Rule 29).
4. **Build orchestrator adapter (orchestrator-project session, coder).** Add `warp` adapter + `wh_focus` to `workspace-host.sh`; wire reconciler to consume `surface_orphaned`; confirm `session-cleanup.sh` close path is now the sole surface-close. **Parallel-eligible with step 3** (different repos, no shared file) — recommend firing 3+4 together after confirm.
5. **Regression gate (tester).** AC-30.x recast: tab disappears on CLI-exit **via the orchestrator path**; #486 non-regression (cmux restart → no mass-kill) via the retained INV-17 probe + reconciler corroboration; standalone `telepty kill` reclaims session with opt-in off (no zombie session) and closes tab with opt-in on.
6. **ADR addenda + CONTEXT.md decision_review_log (architect).** §7 items. Parallel-eligible with 3/4.
7. **Then** commit/publish telepty, propagate adapter via devkit scaffold.

Steps 2 (verify) precedes 3–4 (rework). Steps 3+4(+6) are independent (different repos / docs) → **parallel-first recommendation**; step 5 depends on 3+4 (regression needs both sides); step 7 depends on 5+6.

---

## 10. Honest residual risks (§13 objectivity)

- **Latency (orchestrator-owns O3):** managed close now waits for the Layer-A `CLEANUP_REQUEST`/reconciler path; the crash/Layer-D fallback can lag up to the 60s reconciler tick before the tab vanishes. The `surface_orphaned` event makes this event-driven (reconciler reacts on the event, not only on its tick), shrinking the window — but a lingering ghost tab on the pure-crash path is the accepted tradeoff for the clean boundary. Acceptable: a stray empty tab is cosmetic; a leaked zombie *session* (fixed in telepty) was the real harm.
- **Focus efficacy unproven (telepty-owns O3 / ADR OQ-4):** moving focus to the orchestrator does not *solve* the codex MCP-hang; it just puts the (possibly-ineffective) mechanism in the right place. Keep focus opt-in and treat the codex-unblock hypothesis as a separate, evidence-gated investigation.
- **Warp adapter is unverified against a real Warp CLI surface API** — the adapter shape is specified; the actual `warp` subcommands need a dustcraw/builder pass to confirm `close`/`list`/`focus` verbs exist. If Warp lacks a scriptable surface-close, the `headless` fallback covers it (§17) and Warp support degrades to manual — no correctness regression.
- **`surface_orphaned` is a new event contract** between two repos — a small interface-coupling cost (§1). Justified: it replaces a *worse* coupling (telepty reaching into cmux actuation), and event-emit is BOUNDARY.md:8-sanctioned telepty work.

---

**Bottom line:** Orchestrator (`workspace-host.sh` adapter) owns terminal-surface lifecycle — spawn (already), close, focus, and adapter selection (cmux / **warp** / headless). telepty owns sessions/PTY, probes surface liveness read-only, emits `surface_orphaned`, and reclaims zombie *sessions* (satisfying standalone §9 without surface ownership). The uncommitted #30 `closeSurface`/#31 `focusSurface` actuation in telepty (`daemon.js:1358`, `:2695`, focus wiring; `terminal-backend.js:178-181`, `:199-210`) is removed/relocated before it lands; INV-17 (#486 guard) stays with the probe and is reinforced by reconciler corroboration. This is the simplest correct boundary (§1), the single source of truth (§4/DRY), the §3/§9/§17-compliant placement, and — because the surface-actuation code is uncommitted working-tree state — it is the cheapest it will ever be to get right (§5 best-first).