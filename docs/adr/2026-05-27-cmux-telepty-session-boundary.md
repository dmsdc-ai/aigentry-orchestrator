---
type: adr
status: proposed
date: 2026-05-27
author: aigentry-architect-cmux-telepty-boundary-487
scope: ecosystem
decision_type: one-way
tier: T2
trigger: "Task #487 — boundary decision blocking #486 root-cause remediation: cmux-restart at 09:54 KST killed all wrapped telepty sessions via SIGHUP cascade. Death-tracking hook silently bypassed by 25 ms exit race. Constitution §3 (역할) + §9 (독립) violated."
related:
  - "~/projects/aigentry-orchestrator/docs/reports/2026-05-27-cmux-restart-session-kill-root-cause.md (#486 analyst, 363 lines)"
  - "~/projects/aigentry/docs/CONSTITUTION.md §1 §3 §9 §13"
  - "~/projects/aigentry-telepty/cli.js (lines 1011, 1181-1195, 1446-1469, 1502-1576)"
  - "~/projects/aigentry-orchestrator/bin/open-session.sh (lines 155-216)"
related_tasks: [487, 486, 446]
unblocks:
  - "Implementation dispatch: telepty `allow` SIGHUP-decoupling + sync death-log"
supersedes: []
tags: [boundary, telepty, cmux, session-lifecycle, sighup, article-3, article-9, lightweight-fix]
reviewers_recommended: [codex, gemini]
---

# ADR 2026-05-27: cmux ↔ telepty Session-Lifecycle Boundary

## §1 Context

On 2026-05-27 09:54 KST the cmux macOS app (pid 48956) restarted. All wrapped `telepty allow` sessions in its process tree died via SIGHUP propagation — orchestrator's claude session + analyst `t485-aigentry-analyst-codex21s`. Neither appeared in `~/.telepty/logs/session-deaths.log`: the death-tracking hook was bypassed by a 25 ms exit race. Root-cause analysis (#486 analyst report, HIGH confidence on H1+H2, MEDIUM-HIGH on H3) attributes the failure to two coupled defects in `aigentry-telepty/cli.js` and `aigentry-orchestrator/bin/open-session.sh`. The defect manifests for **every** "visible" terminal backend (cmux/aterm/tmux/wezterm/iterm) — only the `telepty spawn` daemon-PTY branch is detached.

This bug erases two Constitution invariants. Per **§3 (역할 침범 금지)** cmux is a *visible UI container* and telepty is a *session daemon + supervised PTY* — distinct roles. The current spawn chain (cmux → login → zsh → telepty-allow → claude) routes telepty's session existence through cmux's kernel session, letting cmux's lifecycle dictate telepty's. Per **§9 (독립)** each component must function standalone, not coupled to another's lifecycle; telepty-allow does not satisfy this today.

## §2 Decision drivers (ranked)

1. **Constitution §3 + §9 restoration** — non-negotiable invariants.
2. **Universality across backends** — the bug affects all 6 spawn paths in `open-session.sh:155-216`; a cmux-only fix leaves §9 broken elsewhere.
3. **§1 경량 — smallest viable refactor cost** — prefer the least-invasive change that satisfies (1) + (2).
4. **UX preservation** — visible stdout during normal operation; explicit per-workspace close semantics.
5. **Daemon independence ceiling** — long-term cleanness of the daemon ↔ allow boundary.

Drivers (1) and (2) gate; (3) selects; (4) and (5) inform tradeoff disclosure and phase-2 trigger.

## §3 Options analyzed

### (a) telepty-allow SIGHUP-decoupling (in-binary, no setsid)

**Mechanism**: `aigentry-telepty/cli.js` `allow` command installs an explicit `SIGHUP` handler that does NOT exit — overriding Node's default `SIGHUP → exit` behavior. Optional belt-and-suspenders: also call `process.on('SIGHUP', () => {/* log + continue */})`. Controlling TTY ownership is **unchanged** (no `setsid` call). The process simply refuses to die from the kernel SIGHUP cascade emitted when its parent terminal app closes its pty masters. Once the parent (cmux/login) exits, the orphan is reparented to init (ppid=1) by macOS — standard Unix orphan adoption.

- **Scope**: `aigentry-telepty/cli.js` only. Single repo, single command, ~3 line-range edits.
- **Implementation surface**:
  - `cli.js:1565-1576` — current handler treats SIGHUP same as SIGTERM/SIGQUIT (routes to `closeAllowSession` + `exitAllowSession`). Remove SIGHUP from the trapped list; install a separate no-exit SIGHUP handler that logs but does NOT propagate to child or call `exitAllowSession`.
  - `cli.js:1467-1469` — `exitAllowSession` keeps its semantics for the remaining trapped signals (SIGTERM, SIGQUIT) but switches to sync-before-exit (see §5).
  - `cli.js:1011` (start of `allow` block) — no changes required for the SIGHUP-only path. **No `process.setsid()` call, no posix npm dep, no `setsid(1)` shell wrapper.**
- **Pros**:
  - Symmetric: one file change fixes all 6 spawn backends (open-session.sh table §2A of #486 report).
  - Smallest §1 footprint. No new dependencies. No new IPC surface.
  - §9 satisfied: telepty-allow no longer dies because cmux died.
  - Visible-output UX preserved during normal operation — stdout fd inherits the pty slave; writes continue to display in the host terminal until the master is closed.
  - Constitutional §3 restored: telepty's death is no longer triggered by cmux's death event.
- **Cons / tradeoffs (declared)**:
  - **UX regression — Cmd+W single-workspace close.** When the user closes one cmux workspace tab (vs quitting cmux), the kernel delivers SIGHUP to that workspace's telepty-allow. With SIGHUP-ignored, the session does NOT die. User must `telepty kill <sid>` to terminate explicitly. Argued acceptable: explicit kill is the §9-aligned close path anyway; the previous behavior conflated "I closed a window" with "kill the LLM CLI mid-task."
  - **Post-parent-death visible output**: after cmux exits, writes to the (now-closed) pty slave fail with EIO. The wrapped CLI keeps running daemon-side and is re-attachable via `telepty attach <sid>`, but visible terminal feedback is severed until reattach. Same severance as before — but now the SESSION SURVIVES, which is the point.
  - SIGTERM cascade NOT covered (see §3.f — separate question).
- **Risks**: low. The Node default SIGHUP-exit behavior is well-documented and the override is a single `process.on` call. macOS pty/SIGHUP semantics are stable.

### (b) cmux-side child reparenting on app quit

**Mechanism**: modify cmux's Electron-side workspace-quit path so cmux does NOT close pty masters on app shutdown; instead it `disown`s workspaces (process group remains alive, ppid reparented to init). On next cmux launch, scan for orphan workspaces and reattach.

- **Scope**: `/Applications/cmux.app/Contents/Resources/app.asar` (Electron main; asar-packed). Plus `bin/open-session.sh:176` if cmux gains a new `--detached`/`--reparent-on-quit` flag.
- **Implementation surface**: cmux upstream — orphan-workspace inventory (`cmux list-orphans`, `cmux reattach <id>`), quit-handler rework, asar unpack/repack workflow. Analyst session did not inspect the asar (read-only boundary). Significant new feature surface in a sibling repo.
- **Pros**: preserves all current UX (Cmd+W kills session, visible output during reattach). Constitution §3 honored at the **cmux side** — cmux owns workspace lifecycle, so a fix here is in-scope for cmux. Enables crash-and-restart UX for cmux app updates.
- **Cons**:
  - **cmux-only**: aterm/tmux/wezterm/iterm/ghostty still suffer the same bug (§2A table in #486 report). §9 unrestored for non-cmux launchers.
  - **Constitution §17 (무의존) drift**: aigentry should not bake in cmux-specific recovery; a cmux-only fix is an architectural admission that telepty's lifecycle IS cmux-coupled, contradicting §9.
  - Larger refactor than (a). Reattach semantics + orphan TTL + workspace-identity persistence are non-trivial.
- **Risks**: cmux source access uncertain; asar repack invalidates code signature; sibling-repo dispatch needed.

### (c) Daemon-side orphan PTY reattach

**Mechanism**: telepty daemon takes ownership of the wrapped-CLI PTY (currently owned by the `telepty allow` process via node-pty's `forkpty`). When the `allow` foreground process disconnects (WS close without DELETE), daemon detects the orphan, keeps the PTY alive, and a fresh `telepty allow` (or `telepty attach`) re-binds on demand.

- **Scope**: `aigentry-telepty/cli.js` (`allow` command refactor) + `aigentry-telepty/daemon.js` (orphan tracking) + `bin/open-session.sh` (spawn semantics converge toward `telepty spawn`).
- **Implementation surface**:
  - `cli.js:1011-1582` — `allow` no longer owns the PTY; it becomes a thin client that POSTs to daemon (like `telepty spawn` does at `cli.js:987-1008`), then attaches interactively.
  - `daemon.js` — adopts the PTY, owns the death log, exposes orphan-list / reattach endpoints. Requires fd-passing of pty pair across process boundary OR daemon-initiated spawn from the outset.
  - `cli.js:1502-1561` — `attachChildExitHandler` (the only `logSessionDeath` site) moves to the daemon; death-log writes are unconditional.
  - `bin/open-session.sh:155-216` — every "visible" branch collapses toward `spawn + attach` semantics.
- **Pros**: cleanest §3 + §9 endgame — daemon owns PTYs end-to-end; `--auto-restart` (#446 / H4 in report) moves to the daemon where it can actually outlive parent kills. No host-terminal dependency.
- **Cons**:
  - **Biggest refactor** — daemon takes over PTY ownership across all spawn paths. fd-passing over unix sockets is invasive (Linux/macOS semantics differ slightly).
  - **Doesn't help on cmux-quit instant**: the user's visible terminal STILL closes (cmux owns that pty); the session is merely re-attachable afterward. From the user's POV, the workspace tab disappeared either way.
  - **§1 violation if used as the first fix**: "can we build this without it?" → yes, (a) suffices for the immediate bug.
- **Risks**: PTY fd-transfer correctness; concurrent-attach race semantics; backward compatibility with existing `telepty allow` consumers.

### (combo) (a) + (b) — symmetric SIGHUP-ignore + cmux-side reparenting

(a) ensures all backends survive; (b) preserves cmux-specific UX (Cmd+W close + visible reattach on cmux relaunch). Combined power is strict superset of either alone. **Rejected** as the initial step: requires cmux-side dispatch + asar work concurrent with telepty work — violates §1 (do the simplest thing first; expand only if needed).

### (phased) phase 1 = (a), phase 2 = (c) (this ADR's choice)

Phase 1 ships (a) as a small surgical fix and observes UX impact in production. Phase 2 promotes to (c) only if the Cmd+W regression or the post-death visible-output severance proves intolerable. Phase 2 is **not committed** by this ADR — it is named as the reserved escalation path so future architects don't re-debate the trajectory.

## §4 Decision

**Phase 1 = (a) telepty-allow SIGHUP-decoupling (in-binary, no setsid). Phase 2 = (c) daemon-PTY reattach, deferred and conditional on Phase 1 UX evidence. (b) rejected outright.**

Argument from §2 drivers:

- **Driver 1 (§3 + §9)**: (a), (c), combo, phased all satisfy. (b) only indirectly — cmux-specific cooperation does not restore §9 for non-cmux launchers. **(b) eliminated.**
- **Driver 2 (universality)**: (a), (c), combo, phased all symmetric. (b) eliminated again.
- **Driver 3 (§1 경량)**: (a) is the smallest viable change: single command in a single file, no new dependencies. (c) is the largest. Combo is medium-but-multi-repo. **(a) wins; (c) deferred.**
- **Driver 4 (UX)**: (a) preserves visible output during normal operation; regresses on Cmd+W close semantics (explicit `telepty kill` required — argued §9-aligned). (c) does not improve the "cmux dies → visible terminal dies" UX. (b) best on UX but eliminated above.
- **Driver 5 (daemon independence)**: (c) is the ceiling. (a) is a useful intermediate. **The phased plan preserves (c) as the architectural endgame.**

The chosen mechanism is **SIGHUP-ignore-without-setsid**. Controlling-TTY ownership stays with the inherited cmux pty pair — `process.setsid()` is **NOT** invoked, no `posix` npm dependency is added, no `setsid(1)` shell-wrapper is prepended at `open-session.sh:176` et al. This precision matters: the original dispatch framed (a) as "setsid-based detach with TTY ownership change → visible-output UX break"; this ADR narrows (a) to the lighter SIGHUP-only path that preserves TTY ownership and visible-output UX during normal operation.

## §5 Death-log race resolution

**Sub-decision: synchronous-before-exit.**

Currently `cli.js:1467-1469` defines:

```javascript
function exitAllowSession(code) {
  setTimeout(() => process.exit(code), 25);
}
```

The 25 ms window races against `cli.js:1508` `logSessionDeath(...)` inside `child.onExit` (`cli.js:1502-1561`). Per #486 §3 step 8, the setTimeout consistently wins on SIGHUP-induced exits → death-log entry never written.

**Decision**: replace the async `setTimeout` with a synchronous death-log write **before** `process.exit`. Two acceptable forms (coder's choice):

- (form A) Move `logSessionDeath` to `exitAllowSession` itself and call it via `fs.appendFileSync` (synchronous I/O), then `process.exit(code)` directly — no setTimeout, no race.
- (form B) Keep the call site at `cli.js:1508` but switch `logSessionDeath` to `fs.appendFileSync` AND replace the `setTimeout(..., 25)` exit with a promise/await on `child.exit` (bounded by a generous timeout, e.g. 500 ms, to avoid hangs if the child wedges).

Form A is simpler and lighter (§1). Form B preserves the existing call-site architecture. Either eliminates the 25 ms race.

Rejected alternatives:
- "Keep async, accept silent drops" — violates Rule 22 (the data we lose is exactly what we need to detect future regressions of this bug class).
- "Increase setTimeout to 500 ms" — doesn't eliminate the race, only widens the window. Still loses on slow-exit children.

## §6 Consequences

### §6.1 What changes (file:line touched in Phase 1)

| Site | Change | Note |
|---|---|---|
| `aigentry-telepty/cli.js:1565-1576` | Remove `SIGHUP` from the `for (const signalName of [...])` array. Install separate `process.on('SIGHUP', () => { /* explicit no-op handler; log to stderr via console.warn for debugging */ })` ABOVE this block. | The no-op handler is REQUIRED — without an explicit handler, Node's default behavior for SIGHUP is to exit the process. |
| `aigentry-telepty/cli.js:1467-1469` | Switch `exitAllowSession` to synchronous death-log + immediate `process.exit` (form A) OR await child.exit (form B). | See §5. |
| `aigentry-telepty/cli.js:1502-1561` | If form A, hoist `logSessionDeath` call out of the `child.onExit` callback into `exitAllowSession`; ensure not double-logged on the auto-restart path. | Form B leaves this alone. |
| `aigentry-orchestrator/bin/open-session.sh` | **No changes.** The fix is entirely in-binary at the telepty layer. | Confirms §3 ownership: telepty owns its own session decoupling. |

### §6.2 What does NOT change (mechanism precision — required clarification)

- **No `process.setsid()` call.** telepty-allow keeps the same kernel session as its parent (login → zsh).
- **No `posix` npm package** added to `aigentry-telepty/package.json`.
- **No `setsid(1)` shell wrapper** added at `open-session.sh:176, 185, 193, 199, 206`.
- **No TTY ownership change.** `process.stdout`/`process.stdin` fds remain bound to the cmux-owned pty slave during normal operation. Visible-output UX is preserved.
- **No daemon refactor in Phase 1.** Daemon-side orphan reattach is Phase 2, NOT this dispatch.

### §6.3 New constraints

- **Cmd+W on a cmux workspace tab no longer terminates the wrapped session.** Users must use `telepty kill <sid>` explicitly. (Acceptable per §3.a Cons disclosure.)
- **After cmux exits**, the wrapped telepty-allow becomes a ppid=1 orphan. It will continue running until: (i) the wrapped CLI exits on its own, (ii) `telepty kill <sid>` is invoked, or (iii) the user reboots. The death-log will record the eventual exit.
- **stdout EIO post-cmux-death**: writes to the closed pty slave will fail with EIO. The telepty-allow process must not crash on this — current code at `cli.js:1484, 1527` (`process.stdout.write(rewritten)`) does not check for write errors. If EIO surfaces as an uncaught error, the process dies anyway and Phase 1 is defeated. **The implementation MUST wrap stdout writes in try/catch** OR install `process.stdout.on('error', () => {/* swallow EIO */})` to avoid this regression.

### §6.4 What becomes possible

- cmux app updates, crashes, or manual quits no longer kill in-flight LLM sessions (the original bug class).
- The same fix protects aterm/tmux/wezterm/iterm spawn paths — no per-backend remediation needed.
- The death log becomes trustworthy: every wrapped-CLI death writes an entry, enabling reliable regression detection for future session-lifecycle bugs.

## §7 Implementation handoff (for next coder dispatch)

### §7.1 Scope (Rule 29 외과적)

**Repo**: `aigentry-telepty` only. **File**: `cli.js`. **Lines**: see §6.1 table.

Out of scope (explicit): cmux Electron internals; daemon refactor; PTY fd-passing; `open-session.sh`; any non-`allow` telepty command.

### §7.2 Mechanism — unambiguous direction for coder

**Use SIGHUP-ignore-without-setsid.** Specifically:

1. Above `cli.js:1565`, add:
   ```javascript
   process.on('SIGHUP', () => {
     // Explicit no-op: decouples telepty-allow lifecycle from parent terminal app.
     // Node default for SIGHUP is process.exit; this handler overrides that default.
     // See ADR 2026-05-27-cmux-telepty-session-boundary §4.
   });
   ```
2. In the existing `for (const signalName of ['SIGTERM', 'SIGHUP', 'SIGQUIT'])` loop at `cli.js:1565-1576`, **remove `'SIGHUP'`** from the array. The loop now traps only SIGTERM and SIGQUIT.
3. Implement death-log sync per §5 (form A preferred).
4. Add `process.stdout.on('error', () => {})` (or equivalent try/catch around stdout writes at `cli.js:1484, 1527`) to swallow post-cmux-death EIO without crashing — see §6.3.

**Do NOT** call `process.setsid()`, do NOT add `posix` npm dep, do NOT add `setsid` shell wrappers at `open-session.sh`. If during implementation a case emerges where SIGHUP-ignore alone seems insufficient (e.g., kernel still delivers SIGHUP via an undocumented path), HOLD inject to architect before reaching for setsid.

### §7.3 SIGTERM cascade scope (required clarification)

**Phase 1 ignores ONLY SIGHUP. SIGTERM remains handled (cleanup + exit).**

Rationale: SIGTERM is the explicit "please terminate" signal — used by `telepty kill <sid>` and by graceful shutdown sequences. We honor it. SIGHUP is the ambient "your controlling terminal hung up" signal — used by the kernel pty-close cascade and by terminal apps on close. We decouple from it.

**Open question for empirical confirmation**: does cmux's graceful quit (Cmd+Q) SIGTERM all workspace children BEFORE closing pty masters? If yes, Phase 1's SIGHUP-ignore does NOT protect against graceful cmux quit — only against crash / auto-update / non-graceful exit (which is the bulk of the 2026-05-27 09:54 incident class, per #486 §1A: cmux had just restarted with ETIME 03:17 — an automatic re-exec consistent with crash/update, not user-initiated Cmd+Q).

If empirical evidence later shows that graceful cmux quit also SIGTERMs children:

- **Phase 1.5** (small extension): introduce a custom shutdown signal — e.g., `SIGUSR1` reserved for daemon-initiated explicit kill, OR a WS-protocol "shutdown" message from daemon to allow — and have `telepty kill` use the new path instead of SIGTERM. Then SIGTERM can be safely added to the ignored set.
- **Phase 2 (c)** (the deferred path): daemon-PTY ownership renders SIGTERM-from-cmux-cascade moot because the daemon owns the PTY and is not in cmux's process tree.

**Coder action for Phase 1**: do NOT extend the ignore set to SIGTERM. Ship SIGHUP-only. If post-deploy evidence shows graceful-quit-via-SIGTERM is a real cascade, dispatch Phase 1.5 separately. This bounded scope honors Rule 29.

### §7.4 Acceptance criteria

The Phase 1 implementation is complete when:

1. **AC-1 (mechanism)**: SIGHUP arrives at telepty-allow → process logs the signal but does NOT exit, does NOT propagate to child. Verifiable via: `kill -HUP <telepty-allow-pid>` from a sibling shell; the process continues, the child claude/codex continues, the death log gains no entry.
2. **AC-2 (cmux-restart survival)**: surrogate-backend repro per #486 §1B(ii) confirms wrapped session survives parent terminal death:
   ```bash
   TMUX_TMPDIR=/tmp tmux -L probe487 new-session -d -s probe \
     "telepty allow --id probe487-tmux --auto-restart codex"
   tmux -L probe487 kill-server
   sleep 2
   pgrep -af 'telepty allow.*probe487-tmux' && echo "PASS: allow survived"
   pgrep -af 'codex.*' | grep -v grep && echo "PASS: child survived"
   ```
3. **AC-3 (death log integrity)**: when the wrapped CLI exits via `telepty kill probe487-tmux` (SIGTERM path), `~/.telepty/logs/session-deaths.log` gains a corresponding entry. The 25 ms race is gone — verifiable by inspecting the new sync-write code path.
4. **AC-4 (stdout EIO survival)**: after parent terminal dies, telepty-allow does NOT crash on subsequent stdout writes. Verifiable via the same surrogate repro extended: after `kill-server`, inject a prompt via daemon and confirm telepty-allow stays alive (stdout write fails silently, child still receives the inject through the WS bridge).
5. **AC-5 (boundary)**: zero edits to `bin/open-session.sh`. Zero edits outside `aigentry-telepty/cli.js`. Confirmed via `git diff --stat` showing exactly one file.

### §7.5 Non-deliverables

- No documentation files (this ADR + #486 report are sufficient).
- No daemon.js changes.
- No `open-session.sh` changes.
- No new tests beyond AC-2/AC-3/AC-4 reproduction commands above (existing test infrastructure under `aigentry-telepty/test/` may not have a fixture for this scenario; coder may add ONE smoke test if cheap, but is not required to build new harness).

### §7.6 Phase 2 trigger (not committed by this ADR)

Phase 2 = (c) daemon-PTY reattach. Trigger conditions (any one suffices to dispatch the Phase 2 architect):

- Cmd+W regression generates ≥3 user complaints within 30 days of Phase 1 ship.
- Post-cmux-death stdout severance proves operationally painful (frequent need to `telepty attach` mid-task disrupts workflow).
- A second bug class emerges where in-process PTY ownership in `telepty allow` couples to launcher lifecycle in a way SIGHUP-ignore cannot fix.

Until a trigger fires, Phase 1 holds.

## §8 Constitution check

- **§1 경량 (Lightweight)** — PASS. Phase 1 is a single-file, ≤30 line diff (handler addition + signal array trim + sync death-log + stdout error guard). No new dependencies. No new abstractions. Deferred (c) is larger but explicitly conditional. Rejected (b) and the full setsid variant of (a) on §1 grounds.
- **§3 (역할 침범 금지)** — PASS. After Phase 1: cmux's role (visible UI container) no longer reaches into telepty's role (session daemon + supervised PTY). The SIGHUP-decoupling installs the boundary at telepty's own process, where it belongs.
- **§9 (독립)** — PASS *with declared tradeoff*. After Phase 1, telepty-allow survives parent terminal death for all 6 backends, satisfying the headline §9 requirement. The residual coupling — telepty-allow's stdout/stdin fds being inherited from the cmux-owned pty pair — remains, but no longer determines lifecycle. Full pty-ownership decoupling is Phase 2's job.
- **§13 (비판적+건설적+객관적)** — PASS. Each option lists balanced pros and cons with file:line citations. The chosen option's UX regression (Cmd+W) is explicitly disclosed in §3.a Cons, §6.3, and §7.4. The mechanism precision clarification (no setsid, no posix dep) is called out in §4, §6.2, and §7.2.
- **§17 (무의존 / Zero External Dependency)** — PASS. No new external dependencies introduced. The fix uses only Node's built-in `process.on` API. The rejected (b) was partly rejected on §17 grounds (cmux-specific recovery would bake in a launcher dependency).
- **Rule 22 (증거 기반)** — PASS. Every option claim cites #486 report sections or `cli.js` / `open-session.sh` file:line. The death-log race is cited at `cli.js:1467-1469` and `cli.js:1508`.
- **Rule 29 (외과적)** — PASS. §7.1 Scope and §7.5 Non-deliverables bound the diff to a single file. Acceptance criterion AC-5 verifies the boundary via `git diff --stat`.

No constitutional waivers declared. No conflicts between §3 and §9 — the chosen path satisfies both.

---

**Status**: proposed — awaiting orchestrator signoff. Next dispatch: coder for `aigentry-telepty/cli.js` Phase 1 implementation per §7.
