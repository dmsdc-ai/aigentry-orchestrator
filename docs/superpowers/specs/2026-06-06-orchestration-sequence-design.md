---
status: draft
date: 2026-06-06
topic: canonical orchestration sequence
---

# Canonical Orchestration Sequence — design

## Context

The orchestrator drives a repeating turn-loop: confirm context with the user →
break the work down → spawn worker sessions through the terminal adaptor → handle
clarifications → collect reports → cleanup → propose the next task. Every piece of
*actuation* already exists as an atomic script (`dispatch.sh`, `session-cleanup.sh`,
`tq-*.sh`, deliberation MCP), but the **sequence itself** — the ordering, the gates,
the human-in-the-loop checkpoints, the transition contract between steps — is not
codified anywhere a turn can mechanically follow. It lives implicitly across
AGENTS.md rules and operator habit.

This design codifies that sequence as a single behavioral contract the orchestrator
invokes each turn, mapped 1:1 onto the existing infrastructure. Where infra is
missing, the gap is tracked as a separate task — the sequence document does NOT
re-implement actuation.

User directive (2026-06-06), verbatim intent:

1. User ↔ orchestrator confirm the working context.
   - 1-1. Per the context, break the work down → decide how many sessions to delegate to.
   - 1-2. Prefer parallel sessions, but choose the count/kind so they do not conflict;
     if conflict is likely, run sequentially.
   - 1-3. When spawning, match the LLM CLI (claude / codex / gemini) to the session's task.
2. Orchestrator spawns a telepty session via the terminal-appropriate adaptor; inject
   context via a **ref file for long context**, **inline for short**.
   - 2-1. A spawned session that needs clarification injects the question back to the
     orchestrator via telepty.
   - 2-2. The orchestrator confirms with the user, then re-injects the answer as context.
   - 2-3. If a spawned session decides it needs another **session** (not the
     orchestrator), it communicates with that session via telepty to obtain the needed
     context. **(see invariant below)**
3. When a session's work finishes, it reports to the orchestrator via telepty.
4. The orchestrator reviews the report, confirms with the user that the session may be
   closed, then cleans up — the terminal session **must also** be cleaned up via the
   running terminal adaptor.
5. Once cleanup is confirmed, the orchestrator proposes the next task from the task
   queue / stored context.

Constraint (binding): the sequence MUST use existing infrastructure; where none exists,
new structure must be **structurally consistent** with existing infra. Ask before
designing if anything is unclear (resolved via the decisions below).

## Decision

### Artifact: ONE cohesive skill + progressive disclosure, not per-step skills

The real atomicity already lives at the **script layer** (`dispatch.sh`,
`session-cleanup.sh`, `tq-*.sh`, deliberation MCP). Re-splitting the skill per step
would duplicate that atomicity across two layers (DRY violation) and produce five
anemic 5-line skills invoked every turn (§1 경량 / YAGNI violation). The value being
codified is the **sequence** — its ordering, gates, and step-to-step transition
contract — which is High-Cohesion by nature: the steps always run 1→2→3→4→5 carrying
shared turn context (which session, which task).

Therefore:

- **One skill `orchestrate-turn`** at `.agents/skills/orchestrate-turn/SKILL.md`
  (symlinked into `.claude/skills/` per existing convention). A *rigid* checklist: the
  per-turn sequence contract that delegates to the already-atomic script layer.
- **Progressive disclosure (extraction-when-it-earns-it):** the SKILL.md is the body;
  a step is extracted into `references/<step>.md` (loaded on demand) ONLY when it grows
  substantial standalone decision logic. None qualify today. Future candidates: 1-1
  work-breakdown heuristics, 1-2 conflict-detection procedure. No premature split.
- **ADR** `docs/adr/2026-06-06-orchestration-sequence.md` — records the sequence, the
  step→infra mapping, the 2-3 policy amendment + rationale, and the gap list.
- **AGENTS.md amendment** — a "표준 오케스트레이션 시퀀스" section linking the skill, and
  the 2-3 rule amendment (below).

### Step → infrastructure mapping (the heart of the skill)

| Step | Action | Existing infra (reused, not reimplemented) |
|------|--------|---------------------------------------------|
| 1 | Confirm context with user | conversation; AskUserQuestion for ambiguity (multi-interpretation surface) |
| 1-1 | Break down → decide # sessions | `work-breakdown` skill + direct `state/task-queue.json` edit (jq); `tq-track.sh`/`tq-status.sh` read-only views |
| 1-2 | Parallel-first, conflict-aware | Rule 9 file-separation judgment → conflict risk ⇒ sequential; ≥3 parallel ⇒ deliberation MCP |
| 1-3 | Match CLI to task | AGENTS.md "CLI별 역할" table (claude=architecture/MCP, codex=impl/test, gemini=websearch/docs) → `--cli` / `--role` |
| 2 | Spawn + ref/inline + adaptor | `dispatch.sh --spawn-and-dispatch --cli --role --ref <file>` (long-context ref file; `--ref` REQUIRED — no `--inline` flag, so "short" context uses raw `telepty inject` ack, a Rule 32 allowed exception) → `bin/open-session.sh` (detect_terminal) → `bin/lib/workspace-host.sh` adaptor |
| 2-1 | Session → orchestrator clarification | `telepty inject` HOLD → orchestrator |
| 2-2 | Orchestrator → user → re-inject | Rule 6 confirm → re-inject: `dispatch.sh --target` for ref-payload re-context (long), `telepty inject` for short inline ack (Rule 32 HARD dispatch-helper boundary) |
| 2-3 | Session ↔ session communication | direct `telepty inject` — **information-request only** (invariant below) |
| 3 | REPORT | `telepty inject` (push) **+ #517 pull-AUTO_REPORT fallback** (reconcile tick detects completion) |
| 4 | Review → confirm → cleanup (both) | Rule 6 confirm → `bin/session-cleanup.sh <sid>` (parent-PID SIGTERM + telepty DELETE + cmux `close-workspace`) |
| 5 | Propose next task | `propose-next-task` skill + `tq-status.sh` / `tq-focus.sh` + `state/task-queue.json` + stored context |

### 2-3 invariant — session↔session is information-only

Direct session-to-session telepty communication is **permitted only for obtaining
information/context** (read-only). It MUST NOT be used to delegate implementation or
any work between sessions.

- ✅ Allowed: a session asks another session for information/context it needs.
- ❌ Forbidden: a session delegating implementation/work to another session.
- If implementation IS needed, the requesting session routes through the orchestrator:
  orchestrator → **confirms with the user (human-in-the-loop)** → **the orchestrator**
  delegates to the appropriate session. Sessions never delegate to sessions.

This preserves spawn-capability gating (only the orchestrator delegates/spawns; ADR-MF
#8) while granting the user's requested direct info exchange.

**Guardrail (anti-§13-loop):** direct session↔session info exchange is capped at
**3 rounds**. If it turns into multi-round debate or surfaces a conflict, it escalates
to deliberation MCP (≥3 parties) or back to the orchestrator. This amends the prior
AGENTS.md HARD rule "세션 간 직접 inject 금지, deliberation 경유 필수" → "context 확보
목적의 직접 telepty inject 허용; 구현 위임 금지; 3라운드 초과 또는 충돌 시 deliberation
에스컬레이션".

### Step 3 — push REPORT with pull fallback

A worker's REPORT inject (push) does not reliably submit into a busy orchestrator
claude TUI (the CR lands in the input box, Enter never fires). So step 3 is
**push-primary + pull-fallback**: the worker still pushes its REPORT, and the reconcile
tick independently pulls completion evidence (git-log + transcript tail) and synthesizes
an AUTO_REPORT for any dispatch whose session is gone with `reported=null` (#517). The
orchestrator never depends solely on the push path.

## Infrastructure gaps (tracked separately — NOT in the skill body)

| Gap | Affects | Status |
|-----|---------|--------|
| #517 pull-AUTO_REPORT | step 3 robustness | in-flight (rec-coder-reconcile-2 D2) |
| orphan-prune fix | step 4 cleanup correctness | in-flight (rec-coder-reconcile-2 D1) |
| #516 non-cmux host spawn | step 2 cross-terminal (§2) | queued — cmux fully works; other terminals unimplemented |
| session-cleanup telepty-orphan bail | step 4 cleanup completeness | tracked under #323/#340 — `session-cleanup.sh` bails early when the session is gone from telepty, skipping the terminal-adaptor close, so a telepty-orphaned-but-cmux-alive workspace lingers (verified live 2026-06-06: rec-coder-reconcile-2 workspace:47). Step 4 requires BOTH surfaces cleaned regardless of telepty state. |
| ~~no propose/breakdown skill~~ (CORRECTION) | steps 1-1 / 5 | `work-breakdown` + `propose-next-task` skills EXIST (`~/dotfiles/claude/skills/`) — orchestrate-turn REFERENCES them (reuse, DRY); not inlined |

The skill documents these as known-limited surfaces so a turn does not assume
cross-terminal spawn or pull-report exist before they land.

## Verification (goal-converted)

- The `orchestrate-turn` skill passes the spec-document-reviewer loop.
- Every row of the step→infra table maps to a **real, runnable command** — verified by
  the command existing in `bin/` / MCP (the mapping is the test).
- The 2-3 invariant is stated unambiguously (info-only; delegation routes through
  orchestrator + human) with the 3-round cap.
- The three infra gaps each carry their own acceptance test in their own task; the
  skill marks them as not-yet-available where relevant.

## Out of scope (YAGNI)

- A full end-to-end driver script automating the loop (rejected: steps 1, 2-2, 4 are
  human-in-the-loop; the orchestrator is a conductor, not an autopilot — §1).
- Per-step skills (rejected above).
- New conflict-detection tooling for 1-2 (file-level Rule 9 judgment suffices today;
  extract to `references/` only if it earns it).
