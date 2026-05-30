---
type: adr
status: proposed
date: 2026-05-29
author: aigentry-architect-telepty-lifecycle
scope: ecosystem
decision_type: reversible
tier: T2
trigger: "Analyst T-telepty-lifecycle-verify adjudicated 7 telepty lifecycle issues @ HEAD 08cd796 (2026-05-29). Three need DESIGN before code: #17 CONNECTED-zombie GC, #30 terminal-surface close adapter, #31 codex spawn-time focus primitive. Rule 24 SPEC FIRST — this ADR is the spec; coder implements after approval."
related:
  - "~/projects/aigentry-orchestrator/docs/adr/2026-05-27-cmux-telepty-session-boundary.md (#487 ADR — Phase 1=(a) SIGHUP-decouple shipped 08cd796; Phase 2=(c) daemon-PTY reattach deferred §7.6)"
  - "~/projects/aigentry-telepty/docs/reports/2026-05-29-telepty-lifecycle-open-vs-fixed.md (analyst verdict report)"
  - "~/projects/aigentry-telepty/daemon.js (3082-3124 health/GC loop, 3314-3328 ownerWs close, 1180-1237 destroy helper, 1429 register, 2529 DELETE, 1240 terminalBackend import)"
  - "~/projects/aigentry-telepty/terminal-backend.js (cmux surface adapter — send/send-key/surfaceCache)"
  - "~/projects/aigentry-telepty/cli.js (1446 closeAllowSession, 1456 DELETE-on-exit, 1421/1457 reconnect)"
related_tasks: [17, 30, 31, 487, 488, 486]
unblocks:
  - "Coder dispatch: telepty daemon + terminal-backend.js surface-liveness GC, close adapter, focus primitive"
supersedes: []
tags: [telepty, cmux, session-lifecycle, gc, surface-adapter, focus, article-1, article-3, lightweight-fix]
reviewers_recommended: [codex, gemini]
---

# ADR 2026-05-29: telepty Lifecycle — CONNECTED-zombie GC, Surface-close Adapter, codex Focus Primitive

> Addendum to **ADR 2026-05-27 (#487)**. #487 shipped Phase 1 = (a) SIGHUP-decouple
> (commit `08cd796`); this ADR resolves three side-effects/gaps the analyst surfaced at that
> HEAD. It does **not** re-open #487's Phase-1-vs-Phase-2 decision; it explicitly adjudicates
> the #487 §7.6 Phase-2 trigger for #17 (verdict: **NOT-TRIGGERED**).

## §1 Context

The `08cd796` SIGHUP-decouple (#487 Phase 1) made wrapped `telepty allow` bridges **survive**
terminal-app death — the intended fix for incident #486 (cmux app restart at 2026-05-27 09:54
killed all sessions). The analyst report (2026-05-29, `08cd796`) confirms the survival works but
surfaces three consequences/gaps requiring design before any code:

- **#17 (PARTIAL)** — survival SHIFTED the GC symptom: the bridge now survives, so its `ownerWs`
  never closes, so the daemon's disconnect-GC guard (`daemon.js:3109-3113`) never fires. A session
  whose cmux workspace was closed becomes a **CONNECTED-but-headless zombie** that accumulates and
  is never reclaimed.
- **#30 (TRUE-OPEN)** — `cmuxSurfaceId`/`cmuxWorkspaceId` are stored as metadata
  (`daemon.js:135,1154,1252,1443,1477`) but **never used to close a UI surface**. Closing a telepty
  session leaves the cmux/Warp tab visibly alive.
- **#31 (needs-design)** — codex spawned via `cmux new-workspace --command "telepty allow … codex"`
  hangs at `Starting MCP servers (0/3)`; the new workspace is never foregrounded and **no
  focus/foreground primitive exists in code** (`daemon.js:1802` only *reads* `foreground_processes`).

Decision drivers (ranked): **(1)** Constitution §1 경량 — smallest design that resolves each;
**(2)** non-regression of #487/#488/#486 (survival across cmux app-quit MUST be preserved);
**(3)** §3 역할 — name the owning component per fix; **(4)** Rule 29 외과적 — handoffs scope exact
lines, no drive-by.

**Load-bearing code facts (verified read-only @ `08cd796`):**

- GC guard `daemon.js:3109-3113`: `shouldCleanupDisconnected = (wrapped||aterm) && !isOpenWebSocket(ownerWs) && (no clients) && disconnectedSeconds >= SESSION_CLEANUP_SECONDS(300)`.
- `ownerWs` is set to `null` + `markSessionDisconnected` is called **only** in `ws.on('close')`
  (`daemon.js:3317-3324`). Post-`08cd796` the bridge does not exit, the WS stays open → this never runs.
- `terminal-backend.js` is **already the cmux surface adapter**: `detectTerminal()` returns
  `cmux|kitty|headless`; `refreshSurfaceCache()` builds a sessionId→surface map from
  `cmux list-pane-surfaces`; `cmuxSendText`/`cmuxSendEnter` issue `cmux send`/`send-key`. It is
  imported at `daemon.js:1240`. It currently has **no `close` and no `focus`** method.
- A destroy helper at `daemon.js:1180-1237` (invoked by `DELETE /api/sessions/:id`, `daemon.js:2529`)
  kills the child, closes `clients`+`ownerWs` (code 1000 'Session destroyed', `:1219`), deletes the
  entry, persists.
- cmux CLI primitives available: `close-workspace --workspace`, `close-surface --surface`,
  `select-workspace --workspace`, `focus-pane --pane [--workspace]`, `focus-window`,
  `set-app-focus active|inactive|clear`, `list-pane-surfaces`, `ping`, and **`set-hook <event> <command>`**
  (event-hook mechanism — exact close-event name unconfirmed, see §2 OQ-1).

---

## §2 Decision #17 — CONNECTED-zombie GC via surface-liveness probe (NOT Phase 2c)

**Decision:** Add a **cmux surface-liveness signal** to the daemon, reclaiming a wrapped cmux
session whose workspace was **explicitly closed** while its bridge survived. Reuse the existing
`terminal-backend.js` adapter and the existing destroy helper. **Do NOT trigger #487 Phase 2(c)**
(daemon-PTY reattach). Owner: **telepty daemon + terminal-backend.js** (§3 telepty-side).

### §2.1 #487 §7.6 Phase-2 trigger verdict — **NOT-TRIGGERED**

The three §7.6 triggers, quoted verbatim, mapped to #17:

1. *"Cmd+W regression generates ≥3 user complaints within 30 days of Phase 1 ship."* — Not the
   #17 class (zombie accumulation, not a UX-complaint count). **No match.**
2. *"Post-cmux-death stdout severance proves operationally painful."* — Concerns reattach friction,
   not registry/zombie accumulation. **No match.**
3. *"A second bug class emerges where in-process PTY ownership in `telepty allow` couples to launcher
   lifecycle in a way SIGHUP-ignore cannot fix."* — **Closest match, and its first clause is
   satisfied**: #17 *is* a second bug class, and it arises because in-process PTY ownership keeps the
   bridge (hence `ownerWs`) alive after the launcher closes the workspace, which SIGHUP-ignore alone
   does not clean up.

**Verdict: NOT-TRIGGERED.** Condition #3's *remedy* — Phase 2(c) daemon-PTY ownership with fd-passing
— is **not what #17 requires**. The daemon does **not** need to own the PTY to detect that a cmux
workspace is gone: it already stores `cmuxWorkspaceId`/`cmuxSurfaceId` and already queries cmux via
`terminal-backend.js`. A **surface-liveness probe + the existing destroy helper** reclaims the zombie.
Per §1 경량 ("이거 없이 직접 구현 가능한가?") the answer is **yes** — so Phase 2(c) stays deferred and
#17 ships as the lighter daemon-side cleanup below. (Were trigger #1 or #2 to fire independently from
real UX evidence, Phase 2(c) would still be on the table — this verdict scopes #17 only.)

### §2.2 FIRM INVARIANT — must not regress #488/#486

> **INV-17 (non-negotiable):** The probe MUST distinguish **explicit single-workspace close**
> (cmux process **alive**, one workspace/surface absent → GC that session) from **cmux app-quit /
> restart** (cmux process **gone**, ALL surfaces vanish → **PRESERVE** every session for reattach,
> exactly the #488/#486 survival guarantee). A naive "surface absent → GC" rule would mass-kill all
> sessions on a cmux app update — re-creating incident #486. This is the whole reason #487 Phase 1
> exists; the #17 fix MUST NOT undo it.

Concretely the probe is **gated on cmux-process-liveness**: if cmux itself is unreachable
(`cmux ping` / `cmux list-windows` fails or throws), the surface state is **INDETERMINATE** → the
probe returns "alive/unknown" and **GCs nothing**. Only when cmux is reachable **and** the specific
workspace/surface is absent from the live list does the session become a GC candidate. This mirrors
the existing aterm-socket pattern at `daemon.js:3082-3100` (socket-gone → mark disconnected;
socket-back → recover), which is the design template.

### §2.3 Mechanism (preferred: event-driven; fallback: gated poll)

**Preferred — event-driven (cleaner, no polling):** if cmux emits a workspace/surface-close event
via `cmux set-hook <event> <command>`, register a hook at workspace creation that calls
`telepty kill <sid>` (or `DELETE /api/sessions/:id`) on close. This is single-pane-scoped by
construction (the hook fires for *that* workspace's explicit close, never on app-quit), so it
satisfies INV-17 without any process-liveness check. **OQ-1 (open question):** the exact cmux
close-event name is unconfirmed (`cmux --help` lists `set-hook <event> <command>` and
`claude-hook session-start|stop|notification` but does not enumerate a workspace-close event;
`cmux set-hook --list` shows none configured). The coder must confirm whether a
`workspace-close`/`surface-close` event exists. If yes → use it (drop the poll path entirely).

**Fallback — gated poll (only if OQ-1 finds no close event):**

1. **Adapter (terminal-backend.js):** add `isSurfaceAlive(session) → 'alive' | 'gone' | 'unknown'`.
   - `'unknown'` if `cmux ping`/`list-windows` fails (cmux unreachable) — **INV-17 gate**.
   - `'gone'` if cmux reachable and `session.cmuxWorkspaceId`/`cmuxSurfaceId` absent from a
     **forced-refresh** of `list-pane-surfaces` (bypass the 30 s `CACHE_TTL` for liveness queries).
   - `'alive'` otherwise. Non-cmux backends (Warp/kitty/headless) return `'unknown'` (out of #17 scope).
2. **Daemon health loop (`daemon.js:3082-3124`, beside the aterm block):** for `backend==='cmux'`
   sessions with `cmuxWorkspaceId` and an OPEN `ownerWs`, on `isSurfaceAlive==='gone'` record
   `session.surfaceGoneAt` (first detection); on `'alive'` clear it (recovery, mirroring aterm
   `:3095-3098`); on `'unknown'` leave unchanged (no GC).
3. **Reclaim:** once `surfaceGoneAt` age ≥ a grace threshold (reuse `SESSION_CLEANUP_SECONDS=300`,
   or a new shorter `SURFACE_ORPHAN_SECONDS` — coder's choice, document it), reclaim via the
   **existing destroy helper** (`daemon.js:1180-1237`) — closes `ownerWs`+`clients`, deletes entry,
   persists. The grace window absorbs cmux transient restarts.

### §2.4 Companion requirement — orphan bridge must EXIT, not reconnect

When the daemon destroys the session it closes `ownerWs` with code 1000 'Session destroyed'
(`daemon.js:1219`). The surviving bridge has reconnect logic (`cli.js:1421` schedules
`reconnectTimer`; `closeAllowSession` clears it at `:1457`). The bridge's `daemonWs` close handler
**MUST treat a 1000/'Session destroyed' close as terminate-no-reconnect** (call
`closeAllowSession`+`exitAllowSession`), otherwise the orphan bridge reconnects and re-registers,
defeating the GC. **OQ-2:** verify/patch the bridge close handler in `cli.js` (around the
reconnect-scheduling site `:1415-1422`) to not reconnect on this close code. This is a small
companion edit on the cli.js side, in scope for #17.

### §2.5 Implementation handoff — #17

- **Repo/files:** `aigentry-telepty/terminal-backend.js` (+`isSurfaceAlive`), `aigentry-telepty/daemon.js`
  (health-loop block ~`3100`; reuse destroy helper `1180-1237`), `aigentry-telepty/cli.js` (close-handler
  guard ~`1415-1457`, per OQ-2). If OQ-1 finds a cmux close-event, the daemon.js poll block is replaced
  by a one-time hook registration at register (`daemon.js:1429`) / spawn site instead.
- **Out of scope (Rule 29):** no PTY fd-passing, no daemon-PTY-ownership refactor (that is Phase 2c, NOT
  triggered), no change to the existing 300 s disconnect-GC guard semantics, no non-cmux backend probe.
- **Acceptance criteria:**
  - **AC-17.1 (GC fires on explicit close):** with cmux alive, `cmux close-workspace --workspace <wid>`
    of a wrapped session → after the grace window the daemon session entry is gone (`telepty list` no
    longer shows it) and the orphan bridge process has exited.
  - **AC-17.2 (INV-17 — app-quit preserves):** kill the cmux app process (all surfaces vanish at once,
    `cmux ping` fails) → **every** wrapped session is PRESERVED (none GC'd); on cmux relaunch they remain
    reattachable. This is the #486/#488 non-regression gate and MUST pass.
  - **AC-17.3 (no reconnect after destroy):** after daemon destroy, the bridge does not reconnect/
    re-register (verify no new session entry reappears).
  - **AC-17.4 (recovery):** a transient surface-absence shorter than the grace window does not GC.

---

## §3 Decision #30 — terminal-surface close adapter (extend, don't add)

**Decision:** Extend the **existing** `terminal-backend.js` adapter with a `closeSurface(session)`
method and invoke it from the **destroy helper** (`daemon.js:1180-1237`) on explicit session close.
**Do not create a new module** (§1 경량). Owner: **telepty daemon + terminal-backend.js**.

### §3.1 Adapter interface (minimal, backend-dispatched like `detectTerminal`)

```
// terminal-backend.js — additions (symmetric with cmuxSendText/cmuxSendEnter)
closeSurface(session) -> boolean        // cmux: `cmux close-workspace --workspace <cmuxWorkspaceId>`
                                        //       (or close-surface --surface <cmuxSurfaceId>)
                                        // kitty: best-effort close-window, else no-op
                                        // headless: no-op, return true
isSurfaceAlive(session) -> 'alive'|'gone'|'unknown'   // shared with #17 (§2.3)
```

Keep it to these two methods. `exists`/`alive` is folded into `isSurfaceAlive`. No interface beyond
what #17/#30 consume (YAGNI / §1).

### §3.2 Plug point — single site covers all close paths

Call `terminalBackend.closeSurface(session)` inside the destroy helper (`daemon.js:1180-1237`), after
closing `ownerWs`/`clients`. This one site covers **all three** close paths through the daemon:

- explicit `telepty kill` / `DELETE /api/sessions/:id` (`daemon.js:2529`);
- normal wrapped-CLI exit — `closeAllowSession` already `DELETE`s the daemon session
  (`cli.js:1456`) → destroy helper → `closeSurface`;
- the #17 surface-gone GC reclaim (§2.3 step 3) — here the surface is **already gone**, so
  `closeSurface` is a harmless no-op (cmux returns not-found). No close-loop, no double-close.

> **Impl correction (2026-05-29, coder self-correction during #30):** the daemon actually has
> **two** destroy paths, not one unified helper — `POST /kill` → `teardownSessionById`, AND an
> *inline* `DELETE /api/sessions/:id` handler (`daemon.js:2556`) that the normal wrapped-CLI exit
> (`cli.js:1468 closeAllowSession`) routes through directly (it does NOT call `teardownSessionById`).
> A single plug-point would have missed **AC-30.2** (tab-close on CLI exit). `closeSurface` is
> therefore wired in **both** sites, which preserves this section's INTENT ("close the surface on
> every daemon-side destroy"). The "one site covers all" wording above is superseded by this note.

### §3.3 UX gate (open question, default chosen)

Auto-closing a surface on **normal CLI exit** would close a tab the user may still be looking at.
**Default decision:** `closeSurface` runs for `backend==='cmux'` wrapped sessions on destroy. **OQ-3:**
if interactive (human-attached) sessions should keep their tab on CLI exit, gate `closeSurface` to
daemon/orchestrator-managed closes (e.g., a `close_surface:true` flag on the DELETE, defaulting true
for orchestrator-spawned workers). Recommend shipping the default and adding the gate only if UX
evidence demands it (§1 — don't pre-build the knob).

### §3.4 Implementation handoff — #30

- **Repo/files:** `aigentry-telepty/terminal-backend.js` (+`closeSurface`), `aigentry-telepty/daemon.js`
  (one call in destroy helper `1180-1237`).
- **Out of scope:** no new adapter module/file; no cli.js change (the DELETE-on-exit path at `:1456`
  already routes through the daemon); no Warp-specific code unless a Warp surface id is actually stored
  (it is not today — `cmuxSurfaceId` only).
- **Acceptance criteria:**
  - **AC-30.1:** `telepty kill <sid>` of a cmux-backed session → the cmux workspace/tab disappears.
  - **AC-30.2:** normal wrapped-CLI exit → tab disappears (via DELETE→destroy→closeSurface).
  - **AC-30.3 (no-op safety):** destroying a session whose surface is already gone (the #17 path) does
    not error and does not block the destroy.
  - **AC-30.4 (headless):** a headless/non-cmux session destroy is unaffected (no-op true).

---

## §4 Decision #31 — codex spawn-time focus primitive (separate, NOT Phase 2c)

**Decision:** The focus gap is a **separate spawn-time focus primitive**, **not** #487 Phase 2(c).
Add `focusSurface(session)` to the **same** `terminal-backend.js` adapter; invoke it **opt-in** at
cmux-session registration for codex spawns. Owner: **focus PRIMITIVE = telepty terminal-backend.js;
focus POLICY (when) = the spawner, expressed as an opt-in flag.** Efficacy needs runtime repro (OQ-4).

### §4.1 Why NOT Phase 2(c)

PTY ownership and UI-surface focus are **orthogonal**. Even if the daemon owned the PTY (Phase 2c),
focusing the cmux workspace still requires a **cmux UI command** (`select-workspace`/`focus-pane`/
`set-app-focus`) — daemon-PTY-ownership does nothing to foreground a cmux surface. Evidence: the
analyst found "nothing ever sets focus … No cmux focus call exists" — the gap is a *missing cmux
call*, not a PTY-ownership gap. So #31 is correctly routed as a focus primitive, independent of #487.

### §4.2 Primitive + routing

```
// terminal-backend.js
focusSurface(session) -> boolean   // cmux: `cmux select-workspace --workspace <cmuxWorkspaceId>`
                                   //     + `cmux focus-pane --pane <surface> --workspace <wid>`
                                   //     + (if app backgrounded) `cmux set-app-focus active`
                                   // kitty/headless: no-op
```

**Routing — opt-in, daemon-on-register (recommended):** blanket focus-on-every-spawn would **steal the
user's focus** during orchestrator fan-out (a real UX hazard). So focus must be opt-in per spawn. Plug
`focusSurface` into the register handler (`daemon.js:1429`): when the register payload carries
`focus_on_spawn:true` (or `command` matches the codex matcher) **and** `backend==='cmux'`, call
`terminalBackend.focusSurface(session)` once, immediately after registration — while codex is still at
"Starting MCP servers", so the focused TTY is present during its init.

- *Why daemon-on-register over spawner-side (`open-session.sh`):* it is universal across spawners,
  reuses the same adapter as #17/#30, and keeps `open-session.sh`'s 6 backends untouched (consistent
  with #487 §6.1 "no open-session.sh changes"). The spawner only sets the opt-in flag.
- *Alternative (acceptable):* the spawner chains `cmux select-workspace --workspace <new-wid>` after
  `cmux new-workspace`. Cleaner §3-wise (spawner owns surface creation→focus) but per-launcher. Either
  satisfies the design; recommend the daemon-on-register opt-in for universality.

### §4.3 Efficacy is unverified (OQ-4) + fallback

**OQ-4 (open question — needs runtime repro I cannot run read-only):** does focusing the workspace
actually unblock codex's `Starting MCP servers (0/3)` hang? The hypothesis (codex needs a focused TTY
to finish MCP init) is from the analyst but unproven at the code layer. The coder/repro track MUST
confirm focus resolves the hang **before** committing the trigger. **Fallback if focus alone does not
unblock:** implement the analyst's companion (b) — make `bootstrap_ready_timeout` (`daemon.js:672,692`)
surface an **actionable error** rather than queue-the-inject-forever, so a stuck codex is visible
instead of silently hanging. Ship the actionable-timeout regardless (it is independently valuable).

### §4.4 Implementation handoff — #31

- **Repo/files:** `aigentry-telepty/terminal-backend.js` (+`focusSurface`), `aigentry-telepty/daemon.js`
  (register handler `1429`, opt-in gate; + actionable timeout at `672/692`). Spawner sets
  `focus_on_spawn` (orchestrator dispatch / `open-session.sh`) — separate, optional.
- **Out of scope:** no Phase 2c daemon-PTY-spawn; no blanket auto-focus; no focus on non-cmux backends.
- **Acceptance criteria:**
  - **AC-31.1 (primitive):** `focusSurface` foregrounds the target cmux workspace (visible focus change).
  - **AC-31.2 (opt-in):** sessions without `focus_on_spawn` do NOT steal focus on spawn.
  - **AC-31.3 (efficacy — gated on OQ-4):** a codex spawned with focus opt-in completes MCP init and
    becomes inject-ready (no permanent `Starting MCP servers (0/3)` hang). **If OQ-4 repro shows focus
    does not unblock, this AC is replaced by AC-31.4.**
  - **AC-31.4 (fallback):** a codex stuck past the bootstrap timeout surfaces an actionable error event
    (not a silent forever-queue).

---

## §5 Constitution check

- **§1 경량 — PASS.** All three reuse the **existing** `terminal-backend.js` adapter (no new module),
  the **existing** destroy helper, and the **existing** aterm-liveness pattern as template. #17 explicitly
  rejects the heavier Phase 2(c) in favor of a probe ("이거 없이 가능한가? → yes"). New surface = three
  small adapter methods + a few call sites. No new dependencies.
- **§3 역할 — PASS, ownership named per fix.**
  - #17 GC = **telepty daemon** (cleanup is the daemon's job; the surface *probe* is a read-only query
    of cmux via the already-sanctioned `terminal-backend` seam).
  - #30 close = **telepty daemon + adapter** issuing a cmux UI command. This is **not** the #487 §3
    violation (which was the *reverse*: cmux's death dictating telepty's lifecycle). telepty closing the
    surface for a session **it owns the lifecycle of** is telepty owning its own end-to-end — symmetric
    with the existing `cmuxSendText`/`send-key` calls.
  - #31 focus = the cmux UI **mechanism** stays cmux's (issued via the adapter); the **policy** (opt-in)
    sits with the spawner so telepty never blanket-steals focus.
- **§17 무의존 — PASS.** No new external deps; cmux is invoked via CLI through the existing adapter, with
  `headless`/no-op fallbacks for non-cmux backends (graceful degradation per §17).
- **Rule 24 SPEC FIRST — PASS.** Design only; §2.5/§3.4/§4.4 are specs for a later coder.
- **Rule 29 외과적 — PASS.** Each handoff scopes exact files/lines and an explicit out-of-scope list.
- **#486/#488 non-regression — PASS by INV-17** (§2.2) + AC-17.2 as the gate.

No constitutional waivers. No §3↔§1 conflict.

## §6 Open questions (carried for the coder / repro track)

- **OQ-1 (#17):** Does cmux emit a `workspace-close`/`surface-close` event via `set-hook`? If yes, prefer
  event-driven GC and drop the poll path. (`set-hook <event> <command>` exists; event names not enumerated.)
- **OQ-2 (#17):** Confirm/patch the bridge close handler (`cli.js ~1415-1457`) to terminate (not reconnect)
  on a 1000 'Session destroyed' daemon close.
- **OQ-3 (#30):** Should interactive (human-attached) sessions keep their tab on normal CLI exit? Default
  = close for cmux wrapped sessions; add a gate only on UX evidence.
- **OQ-4 (#31):** Runtime repro — does focusing the workspace actually unblock codex MCP init? Confirm
  before committing the focus trigger; ship the actionable-timeout fallback regardless.

---

**Status:** proposed — awaiting orchestrator signoff. Next dispatch: coder for `aigentry-telepty`
(`terminal-backend.js` + `daemon.js` + small `cli.js` guard) per §2.5/§3.4/§4.4. **daemon.js is shared
with #29/#32 (analyst serialization map) — sequence the coder edits.**

---

## Addendum — 2026-05-30 (SUPERSEDES the §3 `#30 close = telepty` ownership clause)

**Status of this addendum:** DECIDED + user-ratified. Source:
[`2026-05-30-surface-ownership-boundary-verdict.md`](./2026-05-30-surface-ownership-boundary-verdict.md)
(VERDICT: Terminal-Surface Lifecycle Ownership). This addendum records the verdict's
boundary ruling against the clauses below; it does not re-decide it.

### What is superseded

The verdict supersedes the **§3 Decision #30 ownership clause** and the **§5 §3-역할 line for #30**
(this ADR, lines ~318–320), which read:

> "#30 close = **telepty daemon + adapter** issuing a cmux UI command. … telepty closing the
> surface for a session **it owns the lifecycle of** is telepty owning its own end-to-end — symmetric
> with the existing `cmuxSendText`/`send-key` calls."

**Replaced by (verdict §0/§1/§2/§7):**

> **#30 close = the orchestrator's Workspace Host adapter (`bin/lib/workspace-host.sh` `wh_close`).**
> telepty **emits a `surface_orphaned` bus event**, **reclaims the *session*** (the SURFACE-GC
> session-reclaim stays — BOUNDARY.md:9 session teardown), and **probes liveness read-only**
> (`isSurfaceAlive`, INV-17 gate intact). telepty does **not** actuate surface close on the managed
> path. The **"symmetric with `cmuxSendText`" justification is withdrawn** — *driving* a surface
> (writing bytes into an existing surface) is telepty's role; deciding the surface should *cease to
> exist* is lifecycle control of a UI container the orchestrator created. **Drive ≠ own-existence**
> (verdict §1). This keeps the #487 surface-death→session-death decouple and routes the reverse
> (session→surface) edge through the creator, so neither direction couples telepty to a UI frontend.

The surface-close **actuation** (`closeSurface` cmux `close-workspace` calls; `daemon.js:1358`,
`daemon.js:2695`; `terminal-backend.js:178-181`) is **removed/relocated** from the daemon per verdict
§3. The **session**-reclaim (SURFACE-GC loop) and the read-only `isSurfaceAlive` probe (with the
INV-17 `'unknown'`-on-cmux-unreachable gate) **stay** in telepty — these satisfy the standalone §9
zombie-*session* leak without telepty owning surface-close.

### OQ-3 — default FLIPPED

§3.3 OQ-3 recommended *shipping the default* `closeSurface`-on-CLI-exit inside telepty. **The verdict
flips this default:** the managed path does **NOT** self-close the surface in telepty. Surface close
is the orchestrator's job (reconciler / `session-cleanup.sh` → `wh_close`). The standalone
(orchestrator-absent) case gets a **documented, narrow opt-in** —
`AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1`, **off by default**, never the managed-path default
(verdict §4/§6).

### OQ-4 — still open; focus policy relocated

§4.3 OQ-4 (does focusing the cmux workspace actually unblock codex's `Starting MCP servers (0/3)`
hang?) **remains open** — the verdict does not resolve focus efficacy and treats the codex-unblock
hypothesis as a separately-gated, evidence-required investigation (verdict §4/§10). **Focus *policy +
mechanism* move to the orchestrator:** `wh_focus` is added to `workspace-host.sh` (see the addendum to
[`2026-05-20-session-lifecycle-3-layer.md`](./2026-05-20-session-lifecycle-3-layer.md)); the spawner
decides *when* to foreground (opt-in flag). telepty no longer foregrounds surfaces; the
`focusSurface` actuation wiring is removed from the daemon (verdict §3).

> **#17 (zombie-session GC) is NOT superseded** — its session-reclaim half stays in telepty exactly as
> specified here; only the surface-*close* actuation that #30 fused into the destroy path is relocated.
> See verdict §5 for the #17 split (detect+reclaim-session = telepty; close-surface = orchestrator).
