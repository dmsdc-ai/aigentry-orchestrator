# SPEC — orchestrator-bridge singleton enforcement (tq#620, #618 recurrence)

- **Task**: tq#620
- **Author**: coder (CLAUDE), fix-620
- **Date**: 2026-06-13
- **Mode**: SPEC FIRST (Rule 24) — HOLD for orchestrator approval before any implementation.
- **Branch**: `wt/620-boot-enforcement` (worktree `/private/tmp/wt-620`, base dcd8512)
- **Related**: #539 (`bin/orchestrator-boot.sh` singleton-at-boot), #618 (silent multi-hour "0 reports"), #606 (orchestrator cleanup = user-only), #533 (warn-mode comms-auditor precedent).

---

## 1. Problem (#618, observed live)

The orchestrator ("control tower") is a long-lived `telepty allow --id orchestrator claude --continue` bridge. A **raw restart** (user restarted the cmux pane by typing a bare `telepty allow`, **not** via `bin/orchestrator-boot.sh`) left a **stale 2-day-old `--id orchestrator` bridge alive alongside the new one**.

telepty's `--id` register is **idempotent**: a 2nd `allow --id orchestrator` is accepted and shares the SAME session, but the daemon keeps routing every `inject … orchestrator` to the **registered-first owner** (the stale bridge). Result: worker REPORTs reached the dead bridge and **ZERO arrived at the live TUI for hours — silent failure**. Acutely resolved by the user running `kill -9 <stale-pid>`.

`bin/orchestrator-boot.sh` already prevents this **when invoked** (it SIGKILLs every pre-existing bridge except self/ancestors before `exec`). **The gap is the restart path does not always invoke it.**

---

## 2. Investigation — how is the orchestrator pane launched? (SPEC FIRST step 1)

**Finding: there is NO scripted launch command to repoint. The pane is launched manually.**

Evidence:
- `bin/orchestrator-boot.sh:4` header states it outright: *"The orchestrator ('control tower') session has NO scripted launcher: it was started manually via `telepty allow --id orchestrator claude … --continue`."*
- `docs/reports/2026-05-27-cmux-restart-session-kill-root-cause.md §1A` shows the live process tree: `cmux → /usr/bin/login → -/bin/zsh → node …/telepty allow --id orchestrator claude … --continue`. The bridge is a command typed into the cmux pane's interactive zsh.
- Repo-wide grep for `telepty allow --id orchestrator` / `startupCommand` / `launchCommand` across `*.sh *.py *.mjs *.json *.yaml *.toml`: **no launcher, no cmux profile, no startup-command config** anywhere in the repo. cmux's per-pane startup command (if any) lives in the cmux app's own config, outside this repo, and is set by the user.

**Consequence for Layer (A):** there is no in-repo launch command to mechanically repoint to `boot.sh`. **(A) therefore reduces to docs + ergonomics** — make `boot.sh` the documented, frictionless, idempotent restart command so there is no reason to type a bare `telepty allow`. This raises the importance of Layer (B) (the belt), which is the only *runtime* defense.

---

## 3. Design — two-layer defense-in-depth

### (A) Primary — `orchestrator-boot.sh` as the enforced/documented entry (docs + ergonomics)

`boot.sh` already works and is idempotent (guard is a no-op for 0 or lone-self bridges). The gap is purely that humans bypass it on restart. So (A) is:

1. **AGENTS.md** — `AGENTS.md:24` already names `bin/orchestrator-boot.sh` as the boot path. Strengthen it into an explicit **RESTART** directive: "Orchestrator (re)start — ALWAYS `bin/orchestrator-boot.sh`, NEVER a bare `telepty allow`. A bare restart leaves a stale duplicate bridge → silent 0-report routing (#618)." (surgical edit to the existing bullet, no new section).
2. **Ergonomics** — `boot.sh` is already a one-shot `exec` wrapper and idempotent; no code change needed for it to be the easy path. (Optional, flagged as a fork below: a shell alias/snippet in onboarding docs — but that touches user dotfiles outside the repo, so out of scope unless the orchestrator wants a docs note.)

**No behavioral change to `boot.sh`.** Its self/ancestor protection and SIGKILL-not-SIGTERM rationale are preserved untouched (Rule 29).

### (B) Belt — reconcile detect-and-WARN (the key robustness win)

A check on the periodic reconcile tick that detects **>1 live `telepty allow --id orchestrator ` bridge** and, on a duplicate, emits **telemetry/log + a HOLD inject to the orchestrator** naming the bridge PIDs (with ages, oldest flagged as likely-stale) and the exact `kill -9 <pid>` remedy. This converts #618's silent multi-hour "0 reports" into an immediate operator signal.

#### ⚠️ HARD CONSTRAINT — warn, never kill

Per "오케스트레이터 cleanup은 사용자 전용" (#606, orchestrator bridge kill/cleanup/DELETE is **USER-ONLY**): a background reconcile process is **not the user** and **not an ancestor of either bridge**, so it cannot safely apply `boot.sh`'s self/ancestor protection. **The belt DETECTS and WARNS/HOLDs only.** The user (or `boot.sh` at next boot) does the actual kill. Auto-killing from reconcile = rule violation + risk of killing the *live* bridge.

#### Detection signal shape

- Capture a portable snapshot once: `ps -eo pid,etime,command` (BSD/macOS + Linux; mirrors `boot.sh:48` columns, adds `etime` for age annotation).
- Match `telepty allow --id <ORCH_SID> ` with a **trailing space** (avoids `orchestrator-2` prefix collisions — same marker as `boot.sh:73` / `session-reconciler.sh:415`).
- Count distinct numeric PIDs (skip `<defunct>` zombie rows). Exclude nothing else — the auditor is not itself a bridge, so no self/ancestor exclusion is needed (unlike `boot.sh`).
- **count ≤ 1 → no-op** (the normal, common case — must be silent).
- **count > 1 → duplicate**: log an alert, write telemetry, and (act-only) push ONE HOLD inject to `$ORCH_SID`:

  ```
  HOLD: orchestrator-bridge DUPLICATE | N=2 bridges (expected 1) | pids: 50349(etime 2-08:11:00), 74838(etime 00:05:23) | likely-stale=oldest=50349 | remedy: confirm the live-TUI pid, then `kill -9 <stale-pid>` — USER-ONLY (automation must NOT kill). ref #618
  ```

  The message lists **all** bridge PIDs with ages and flags the **oldest as the likely-stale** candidate (in #618 the stale bridge was the 2-day-old registered-first owner), but explicitly tells the operator to confirm the live-TUI pid before killing — the belt never asserts a kill target with certainty (§13 honesty: it can't know which PID the live TUI runs in).

---

## 4. Where the belt lives — recommendation + fork

**Recommendation: a small standalone `bin/orchestrator-bridge-auditor.sh`, wired one-line into `session-reconciler.sh` as step 0d** (best-effort, act-only, never blocks the tick), exactly mirroring how `session-comms-auditor.sh` is wired at step 0c.

Rationale:
- **Faithful to the warn-mode precedent** the dispatch points at (`session-comms-auditor.sh`): own script + own hermetic test + one-line wire-in.
- **Independently hermetic-testable** like T40 — ps stub + telepty stub, no need to drive the whole 750-line reconciler tick.
- Keeps the reconciler from growing; single-responsibility.

**Fork (orchestrator decides):** the dispatch text says *"Add a check to the reconcile tick (session-reconciler.sh)"*, which could instead mean an **inline function** in `session-reconciler.sh` (no new file, ~20 lines, lighter per Rule 4 경량). Trade-off: inline is fewer files but the reconciler is not cleanly sourceable, so the hermetic test would have to shell the whole tick. **I recommend the standalone script** for testability + precedent-mirror; flagging the inline option because it is the literal reading of the dispatch and the orchestrator may prefer minimal file count.

A second fork: **stale-PID identification.** I propose "list all + flag oldest as likely-stale, operator confirms." Alternative = "name only the older PID(s) as stale." I recommend the former (the reconciler genuinely cannot prove which PID the live TUI runs in; over-confident naming risks pointing `kill -9` at the live bridge).

---

## 5. Test plan (hermetic seams only — no live daemon/cmux/orchestrator touched)

### T40 (existing) — regression GREEN, unchanged

`boot.sh` is not modified, so T40 must stay GREEN as-is.

### T57 (new) — `orchestrator-bridge-auditor` detect-and-warn

HERMETIC, modeled on T40 (ps stub) + T45 (telepty inject stub via `STUB_DISPATCH_LOG`):

- **Seams**: `SINGLETON_PS_CMD`→fixture ps-table stub (mirror T40); `TELEPTY`→lib.sh telepty stub (inject captured to `STUB_DISPATCH_LOG`); `ORCHESTRATOR_SID` overridable.
- **Assertions**:
  - **A) two bridges** (`…--id orchestrator `, pids 50349 + 74838) → exactly ONE HOLD inject to `orchestrator`, naming both pids + `kill -9`; telemetry/log records the duplicate.
  - **B) one bridge** → **no inject** (silent no-op).
  - **C) zero bridges** → no inject.
  - **D) sid precision** → a `--id orchestrator-2 ` bridge alongside one `--id orchestrator ` bridge counts as **1** orchestrator bridge (trailing-space marker) → no inject.
  - **E) warn-NOT-kill** → a `kill` recorder stub on PATH records **zero** calls (the auditor never kills any bridge). This is the #606 invariant under test.
  - **F) act-only** → under `--dry-run` (or the reconciler's `DRY_RUN=1` skip), detection still logs but **no inject** is sent (mirrors comms-auditor act-only wiring).
  - **G) ORCH_SID configurable** → `ORCHESTRATOR_SID=custom-orch` counts only `--id custom-orch ` bridges.

### TDD order

RED first: write T57 against the not-yet-existing `bin/orchestrator-bridge-auditor.sh` (assert it fails), then implement until GREEN, then full `tests/dispatch/run-all.sh` (esp. T40 + reconciler T22/T26/T29) GREEN.

---

## 6. Invariants (carried from dispatch)

- Belt = **detect + warn/HOLD ONLY. Never auto-kill an orchestrator bridge** (#606 user-only).
- `boot.sh` self/ancestor protection + SIGKILL-not-SIGTERM rationale **preserved untouched**.
- Hermetic tests only (`SINGLETON_PS_CMD`/`KILL_CMD`/`TELEPTY` seams) — live daemon/cmux/orchestrator untouched. Rule 29 surgical.
- Cross-OS: portable `ps -eo pid,etime,command` (BSD/macOS + Linux), mirroring existing seams.
- Article 17: pure bash + telepty + (python3 stdlib only if needed). No npm runtime deps.
- Snyk At-Inception: changes are bash (Snyk-unsupported) → `snyk_code_scan` N/A; will state so at DONE. (No node/JS first-party code added.)

---

## 7. Files to change (after approval)

- `bin/orchestrator-bridge-auditor.sh` — **NEW** (the belt; warn-only detector). *(or inline into `session-reconciler.sh` if the orchestrator picks the inline fork.)*
- `bin/session-reconciler.sh` — **+~4 lines**: wire step 0d (best-effort, act-only, `DRY_RUN`-skipped), mirroring step 0c (comms-auditor).
- `tests/dispatch/T57_orchestrator_bridge_duplicate_warn.sh` — **NEW** hermetic test.
- `AGENTS.md` — strengthen the existing `:24` boot bullet into an explicit RESTART directive (surgical, 1 bullet).

---

## 8. HOLD

This is the SPEC-FIRST boundary (§13 explicit HOLD — no silent waiting). **Awaiting orchestrator approval** of:
1. The (A)docs+ergonomics + (B)reconcile-detect-warn design.
2. **Fork 1** — standalone `bin/orchestrator-bridge-auditor.sh` (recommended) vs inline in `session-reconciler.sh`.
3. **Fork 2** — stale-PID signal: "list all + flag oldest, operator confirms" (recommended) vs "name only older as stale".

No code past this boundary until approved.
