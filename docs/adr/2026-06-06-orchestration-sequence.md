---
status: accepted
date: 2026-06-06
topic: canonical orchestration sequence
---

# ADR 2026-06-06 — Canonical Orchestration Sequence

## Context

The orchestrator drives a repeating turn-loop: confirm context with the user → break the work down → spawn worker sessions through the terminal adaptor → handle clarifications → collect reports → cleanup → propose the next task. Every piece of *actuation* already exists as an atomic script (`bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh`) or MCP (deliberation). What did NOT exist anywhere a turn could mechanically follow was the **sequence itself** — the ordering, the gates, the human-in-the-loop checkpoints, and the step-to-step transition contract. It lived implicitly across AGENTS.md rules and operator habit.

User directive (2026-06-06), verbatim intent:

1. User ↔ orchestrator confirm the working context.
   - 1-1. Per the context, break the work down → decide how many sessions to delegate to.
   - 1-2. Prefer parallel sessions, but choose the count/kind so they do not conflict; if conflict is likely, run sequentially.
   - 1-3. When spawning, match the LLM CLI (claude / codex / gemini) to the session's task.
2. Orchestrator spawns a telepty session via the terminal-appropriate adaptor; inject context via a **ref file for long context, inline for short**.
   - 2-1. A spawned session that needs clarification injects the question back to the orchestrator via telepty.
   - 2-2. The orchestrator confirms with the user, then re-injects the answer as context.
   - 2-3. If a spawned session decides it needs another **session** (not the orchestrator), it communicates with that session via telepty to obtain the needed context (see invariant below).
3. When a session's work finishes, it reports to the orchestrator via telepty.
4. The orchestrator reviews the report, confirms with the user that the session may be closed, then cleans up — the terminal session **must also** be cleaned up via the running terminal adaptor.
5. Once cleanup is confirmed, the orchestrator proposes the next task from the task queue / stored context.

Binding constraint: the sequence MUST use existing infrastructure; where none exists, new structure must be **structurally consistent** with existing infra. The sequence document does NOT reimplement actuation.

## Decision

### One cohesive skill + progressive disclosure — not per-step skills

The real atomicity already lives at the **script layer** (`dispatch.sh`, `session-cleanup.sh`, `tq-*.sh`, deliberation MCP). Re-splitting the skill per step would duplicate that atomicity across two layers (DRY violation) and produce five anemic ~5-line skills invoked every turn (§1 경량 / YAGNI violation). The value being codified is the **sequence** — its ordering, gates, and step-to-step transition contract — which is High-Cohesion by nature: the steps always run 1→2→3→4→5 carrying shared turn context (which session, which task).

Therefore:

- **One skill `orchestrate-turn`** at `.agents/skills/orchestrate-turn/SKILL.md` (symlinked into `.claude/skills/` per existing convention). A *rigid* per-turn checklist that delegates to the already-atomic script layer and never reimplements spawn/inject/cleanup/queue mutation. The orchestrator never writes `bin/` code (Rule 4/13).
- **Progressive disclosure (extraction-when-it-earns-it):** SKILL.md is the body; a step is extracted into `references/<step>.md` (loaded on demand) ONLY when it grows substantial standalone decision logic. None qualify today — no premature split. Future candidates: 1-1 work-breakdown heuristics, 1-2 conflict-detection procedure.
- This ADR + an AGENTS.md "표준 오케스트레이션 시퀀스" pointer + the 2-3 rule amendment below.

### Step → infrastructure mapping (verified auditable)

Every row maps to a real, runnable command — the mapping IS the test. Verified 2026-06-06 against the live tree (`bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-{track,status,focus}.sh`, `bin/dispatch-tracker.sh`, `bin/open-session.sh`, `bin/lib/workspace-host.sh` all present/executable).

| Step | Action | Existing infra (reused, not reimplemented) |
|------|--------|---------------------------------------------|
| 1 | Confirm context with user | conversation; AskUserQuestion for ambiguity |
| 1-1 | Break down → decide # sessions | `work-breakdown` skill + direct `state/task-queue.json` edit (jq); `bin/tq-track.sh`/`bin/tq-status.sh` read-only views |
| 1-2 | Parallel-first, conflict-aware | Rule 9 file-separation → conflict ⇒ sequential; ≥3 parallel ⇒ deliberation MCP |
| 1-3 | Match CLI to task | AGENTS.md "CLI별 역할" table → `--cli` / `--role` |
| 2 | Spawn + ref/inline + adaptor | `bin/dispatch.sh --spawn-and-dispatch --cli --role --ref` (long-context ref file; short inline ack via raw `telepty inject`) → `bin/open-session.sh` (`detect_terminal`) → `bin/lib/workspace-host.sh` adaptor |
| 2-1 | Session → orchestrator clarification | `telepty inject` HOLD → orchestrator |
| 2-2 | Orchestrator → user → re-inject | Rule 6 confirm → `bin/dispatch.sh --target` (long) / `telepty inject` (short) |
| 2-3 | Session ↔ session communication | direct `telepty inject` — information-request only (invariant) |
| 3 | REPORT | `telepty inject` push + #517 pull-AUTO_REPORT fallback (`bin/dispatch-tracker.sh check` via reconcile tick) |
| 4 | Review → confirm → cleanup (both) | Rule 6 confirm → `bin/session-cleanup.sh <sid>` (parent-PID SIGTERM + telepty DELETE + cmux `close-workspace`) |
| 5 | Propose next task | `propose-next-task` skill + `bin/tq-status.sh` / `bin/tq-focus.sh` + `state/task-queue.json` |

### 2-3 invariant — session↔session is information-only

Direct session-to-session telepty communication is **permitted only for obtaining information/context** (read-only). It MUST NOT be used to delegate implementation or any work between sessions.

- ✅ Allowed: a session asks another session for information/context it needs.
- ❌ Forbidden: a session delegating implementation/work to another session.
- If implementation IS needed, the requesting session routes through the orchestrator: requesting-session → orchestrator → **confirm with the USER (human-in-the-loop)** → the **orchestrator** delegates to the appropriate session. Sessions never delegate to sessions.

**Rationale.** This preserves spawn-capability gating — only the orchestrator delegates/spawns (ADR-MF #8 Permission Manager; `src/session/permission-manager.ts`, spawn gated on `SessionContext.permissions` capability) — while granting the user's requested direct info exchange. If sessions could delegate *work* to one another, spawn/delegation authority would leak below the orchestrator, re-introducing the implicit ungated spawn that ADR-MF #8 forbids. Read-only info exchange carries no spawn authority, so it is safe to permit. The prior AGENTS.md HARD rule "세션 간 직접 inject 금지, deliberation 경유 필수" was a blunt total ban; this narrows the ban to *work delegation* and opens *read-only info exchange*, without weakening who is allowed to spawn/delegate.

**Guardrail (anti-§13-loop):** direct session↔session info exchange is capped at **3 rounds**. If it becomes multi-round debate or surfaces a conflict, it escalates to deliberation MCP (≥3 parties) or back to the orchestrator. This bounds the relaxed channel so it cannot regress into the unstructured cross-talk the original ban was protecting against. The AGENTS.md amendment: "세션 간 직접 inject 금지" → "정보 확보 목적의 직접 telepty inject 허용 (read-only); 구현 위임 금지 (오케스트레이터 경유 → 사용자 확인 → 오케스트레이터 위임); 3라운드 초과 또는 충돌 시 deliberation 에스컬레이션." This is an **information-only** amendment: it grants a read-only channel and tightens the escalation trigger; it does NOT relax the no-work-delegation or spawn-gating contracts.

### Step 3 — push REPORT with pull fallback

A worker's REPORT inject (push) does not reliably submit into a busy orchestrator claude TUI (the CR lands in the input box, Enter never fires). Step 3 is therefore **push-primary + pull-fallback**: the worker still pushes its REPORT, and the reconcile tick independently pulls completion evidence (git-log + transcript tail) and synthesizes an AUTO_REPORT (`bin/dispatch-tracker.sh check`) for any dispatch whose session is gone with `reported=null` (#517). The orchestrator never depends solely on the push path.

## Consequences

**Positive.** A turn can mechanically follow one rigid checklist; every actuation stays single-owner at the script layer (no duplication — DRY); the conductor/player boundary (Rule 4/13) is explicit; the user's requested direct-info channel exists without weakening spawn-capability gating; §1 경량 (one concise skill, not five).

**Tracked infrastructure gaps (NOT in the skill body — separate tasks; the skill marks them as known-limited surfaces so a turn does not assume they exist before they land):**

| Gap | Affects | Status |
|-----|---------|--------|
| #517 pull-AUTO_REPORT wiring | step 3 robustness | in-flight (rec-coder-reconcile-2) — tracker has AUTO_REPORT; wire into reconcile tick + register dispatches in active.json |
| #516 non-cmux host spawn | step 2 cross-terminal (§2) | queued — cmux fully works; other terminals unimplemented |
| session-cleanup telepty-orphan terminal-close (#323/#340) | step 4 cleanup completeness | tracked — `session-cleanup.sh` bails early when the session is already gone from telepty, skipping the terminal-adaptor close, so a telepty-orphaned-but-cmux-alive workspace lingers |

**Empirical justification (live incident, 2026-06-06).** During the `rec-coder-reconcile-2` reconcile work, cmux **workspace:47** survived as a telepty-orphaned-but-cmux-alive workspace: the telepty session was already gone, so `session-cleanup.sh` hit its early-return on the telepty-miss branch and never invoked the terminal-adaptor close, leaving the cmux workspace lingering (accumulating toward telepty#17 DISCONNECTED buildup). This concrete failure is why step 4 mandates "cleanup BOTH surfaces regardless of telepty state" as a hard, non-skippable gate rather than implicit operator habit, and is the motivating case for the #323/#340 fix being a sequence dependency. The same reconcile session also surfaced HOLD-ignored self-progress (now handled by the 2-1 explicit-HOLD gate) and telepty-orphan no-report (handled by the step-3 push+pull contract).

**Negative / accepted.** No end-to-end driver script automates the loop — steps 1, 2-2, and 4 are human-in-the-loop by design (the orchestrator is a conductor, not an autopilot; §1). The step→infra mapping must be re-verified if `bin/` flags or function names drift.

## Distribution & public installability (decided 2026-06-06, feasibility-verified)

The `orchestrate-turn` skill is **repo-coupled** (it invokes `bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh` by path) so its source-of-truth lives in THIS repo (`.agents/skills/orchestrate-turn/`) and it **travels to public users inside the orchestrator-repo clone** — not as a standalone devkit template (which would duplicate the repo coupling). This supersedes an earlier "standalone devkit template + manual symlink" idea (§1 경량 — no duplication).

A feasibility workflow (adversarially verified, grounded=true) confirmed the **full orchestrator environment CAN be made one-click devkit-installable at MEDIUM difficulty (~80% reuse)** via a new `aigentry-devkit setup --profile orchestrator`:
- new soft-policy manifest component `orchestrator-role` (phase 8, depends devkit-core+telepty+deliberation): git-clone+build the orchestrator repo (carrying the skill), invoke the repo's existing `bin/install-instructions.sh`, **generate (not copy)** the launchd/systemd reconciler unit from a template (3 machine-specific values parameterized: repo path, log path, node bin dir; non-macOS → systemd/none degrade — §2 크로스), generate a parameterized `~/.aigentry/config.json` role→path map, deep-merge the orchestrator Claude hooks, and add a `doctor` health check.

**Critical-path blockers (tracked, NOT in this ADR's scope):**
1. `@aigentry/logger` + `@aigentry/ssot` are local `file:` deps assuming a sibling-repo layout — must be npm-published or vendored as a built `dist/` before a public user can build the clone.
2. `tooling/instructions/roles/orchestrator.md` source has **diverged below** the installed `~/.aigentry/instructions/` copy (3644B source < 6533B installed) — the source must be reconciled to canonical before the install path invokes `install-instructions.sh`, else fresh installs get stale instructions.
3. Credentials (`~/.claude/.mcp.json` GitHub PAT, Brain Device ID) and live runtime state (`~/.aigentry/role-sandbox`, `sessions/`) must be provisioned/prompted at install, NEVER copied from a reference machine.

These are delegated to the aigentry-devkit session (the install wiring) and to logger/ssot publication; this orchestrator repo owns only the skill + ADR + AGENTS.md contract.

