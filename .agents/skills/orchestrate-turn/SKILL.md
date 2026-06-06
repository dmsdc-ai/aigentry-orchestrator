---
name: orchestrate-turn
description: Use every orchestration turn. The canonical 5-step delegation loop — confirm context → spawn via terminal adaptor → handle clarifications → collect report → cleanup both surfaces → propose next. Rigid sequence; delegates to dispatch.sh / session-cleanup.sh / tq-*.sh / deliberation MCP. Does NOT reimplement actuation. Each step names the failure it prevents.
---

# orchestrate-turn

The orchestrator's per-turn delegation contract. **Rigid checklist** — run the steps in order, every turn, carrying shared turn context (which session, which task).

**This skill sequences; it does NOT actuate.** All actuation already lives at the atomic script layer (`bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh`, deliberation MCP). The skill owns only the ordering, gates, and human-in-the-loop checkpoints — it never reimplements spawn, inject, cleanup, or queue mutation. The orchestrator never writes `bin/` code itself (Rule 4/13) and never spawns/delegates outside this gated path (only the orchestrator delegates/spawns — ADR-MF #8 spawn-capability gate).

Read each step as a failure-mode tripwire: it states **what goes wrong if you skip it**.

## Step → infrastructure map (reused, never reimplemented)

| Step | Action | Existing infra |
|------|--------|----------------|
| 1 | Confirm context with user | conversation; AskUserQuestion for ambiguity (multi-interpretation surface) |
| 1-1 | Break down → decide # sessions | `work-breakdown` skill (decompose to parallelizable tasks) + register via direct `state/task-queue.json` edit (jq); `bin/tq-track.sh`/`bin/tq-status.sh` read-only views |
| 1-2 | Parallel-first, conflict-aware | Rule 9 file-separation judgment → conflict risk ⇒ sequential; ≥3 parallel ⇒ deliberation MCP |
| 1-3 | Match CLI to task | "CLI별 역할" table (claude=architecture/MCP, codex=impl/test, gemini=websearch/docs) → `--cli` / `--role` |
| 2 | Spawn + ref/inline + adaptor | `bin/dispatch.sh --spawn-and-dispatch --cli <c> --role <r> --ref <file>` → `bin/open-session.sh` (`detect_terminal`) → `bin/lib/workspace-host.sh` adaptor |
| 2-1 | Session → orchestrator clarification | `telepty inject` HOLD → orchestrator |
| 2-2 | Orchestrator → user → re-inject | Rule 6 confirm → `bin/dispatch.sh --target` (long ref-payload) / `telepty inject` (short ack) |
| 2-3 | Session ↔ session communication | direct `telepty inject` — **information-request only** (invariant below) |
| 3 | REPORT | `telepty inject` push **+ #517 pull-AUTO_REPORT fallback** (`bin/dispatch-tracker.sh check` via reconcile tick) |
| 4 | Review → confirm → cleanup BOTH | Rule 6 confirm → `bin/session-cleanup.sh <sid>` (telepty DELETE + terminal-adaptor close) |
| 5 | Propose next task | `propose-next-task` skill + `bin/tq-status.sh` / `bin/tq-focus.sh` + `state/task-queue.json` + stored context |

---

## Step 1 — Confirm context with the user

Confirm the working context before any breakdown. On ambiguity, surface N interpretations and ask (AskUserQuestion / multi-interpretation surface) — never silently pick one (응답 원칙 §4).

> **If skipped:** you delegate against a guessed intent. The whole wave runs on the wrong target and burns N sessions before the mistake surfaces.

### 1-1 Break down → decide # sessions
Decompose the confirmed work into file/task units — invoke the `work-breakdown` skill to split a spec/description into parallelizable tasks. Register them by appending to `state/task-queue.json` directly (jq) — there is no dedicated add script; `bin/tq-track.sh` (drill into a track) and `bin/tq-status.sh` (board overview) are read-only views, and `bin/tq-focus.sh` only sets `.active_focus`. Decide how many sessions to delegate to.

> **If skipped:** no task-queue trail → step 5 has nothing to propose from, and reconcile cannot reconcile dispatches it never saw.

### 1-2 Parallel-first, conflict-aware
Prefer parallel sessions. Apply Rule 9 file-separation: if two units touch the same file → run **sequentially**, not parallel. ≥3 parallel sessions → route through **deliberation MCP** (conflict detection + synthesis + non-response tracking), per AGENTS.md "병렬 위임 시 Deliberation 경유".

> **If skipped:** two sessions edit the same file → merge corruption / lost work. ≥3 parallel without deliberation → no conflict detection, silent divergence.

### 1-3 Match the CLI to the task
Pick `--cli` by strength: claude (architecture, integration, MCP, debugging), codex (impl, porting, tests), gemini (web search, docs). Pass `--role` so the worker boots in its role-sandbox (Rule 4 cwd→role boundary).

> **If skipped:** `--role` omitted → worker auto-discovers cwd CLAUDE.md and self-IDs as orchestrator (#431 regression). Wrong CLI → low-quality output you re-delegate anyway.

---

## Step 2 — Spawn via the terminal adaptor + inject context

First confirm the full 위임 전 체크리스트 (user-confirmed target, MANDATORY report path, [SAWP] envelope, lessons, SPEC FIRST, self-contained ref for fresh sessions). Then spawn — always via the dispatch helper, never a raw spawn (Rule 32 HARD). `--spawn-and-dispatch` carries the context through a **ref file** (long-context path; short inline acks/follow-ups use raw `telepty inject` — one of the three allowed exceptions):

```bash
bin/dispatch.sh --spawn-and-dispatch --track <T> --name <N> --cwd <P> \
  --cli claude --role <role> --ref <ref-file> --from <orch-sid> [--verify-delivered]
```

`dispatch.sh` registers the dispatch in `state/dispatch/active.json` (the pull-report registry), boots the role-sandbox cwd, and routes through `open-session.sh` (`detect_terminal`) → `workspace-host.sh` adaptor. The skill does NOT spawn terminals directly. After dispatch, **verify started-working** (Rule 33): CONNECTED + ready + clean + moving — `delivered ≠ started`.

> **If skipped:** raw `telepty inject` spawn → no `active.json` row → #517 pull-fallback has nothing to pull → if the REPORT push fails, the dispatch is invisible forever. Skipping Rule 33 verify → you proceed believing a garbled/stuck session is working.

### 2-1 Session → orchestrator clarification
A worker that needs clarification injects a HOLD question back to the orchestrator and **waits** — it does not self-progress past the boundary (`telepty inject` HOLD → orchestrator).

> **If skipped (HOLD-ignored self-progress):** the worker invents an answer and builds the wrong thing — a §13 violation. Enforce explicit HOLD inject; never let a session guess past a HOLD.

### 2-2 Orchestrator → user → re-inject
Confirm the answer with the user (Rule 6), then re-inject as context: `bin/dispatch.sh --target <sid> --ref <file>` for a long re-context payload, or `telepty inject` for a short inline ack.

> **If skipped:** you answer a business/UX question yourself → answer diverges from user intent → the worker's output is rejected at review.

### 2-3 Session ↔ session communication — INFORMATION-ONLY (invariant)

Direct session-to-session telepty communication is **permitted only for obtaining information/context** (read-only). It MUST NOT be used to delegate implementation or any work between sessions.

- ✅ **Allowed:** a session asks another session for information/context it needs.
- ❌ **Forbidden:** a session delegating implementation/work to another session.
- If implementation IS needed, the requesting session routes through the orchestrator: **requesting-session → orchestrator → confirm with the USER (human-in-the-loop) → the ORCHESTRATOR delegates** to the appropriate session. **Sessions never delegate to sessions.**

This preserves spawn-capability gating (only the orchestrator delegates/spawns; ADR-MF #8) while granting the user's requested direct info exchange.

**Guardrail (anti-§13-loop):** direct session↔session info exchange is capped at **3 rounds**. If it turns into multi-round debate or surfaces a conflict, escalate to **deliberation MCP** (≥3 parties) or back to the orchestrator.

> **If skipped (2-3 turns into work-delegation):** a session hands implementation to a peer, bypassing spawn-capability gating and human-in-the-loop. No orchestrator visibility, no user confirm, no `active.json` row — an ungoverned shadow dispatch. The 3-round cap + info-only rule exist to stop exactly this.

---

## Step 3 — Collect the REPORT (push-primary + pull-fallback)

The worker pushes its REPORT via `telepty inject`. Do **not** depend solely on the push: a REPORT CR often lands in a busy orchestrator TUI input box and Enter never fires. The reconcile tick independently pulls completion evidence (git-log + transcript tail) and synthesizes an **AUTO_REPORT** (`bin/dispatch-tracker.sh check`) for any dispatch whose session is gone with `reported=null` (#517).

> **If skipped (telepty-orphan no-report):** you wait forever for a push that silently failed. The session finishes, the workspace orphans, and nothing reports completion. Always treat step 3 as push + pull, never push-only.

---

## Step 4 — Review → confirm → cleanup BOTH surfaces

Review the REPORT against the spec / acceptance criteria. Confirm with the user (Rule 6) that the session may be closed. Then clean up via the helper — which must close **both** the telepty session **and** the terminal-adaptor workspace:

```bash
bin/session-cleanup.sh <sid>
```

This runs parent-PID SIGTERM + telepty session DELETE + the cmux/terminal `close-workspace`. A session is not "cleaned" until both surfaces are gone — terminal surface ownership is the orchestrator adaptor, not telepty (Rule 28).

> **If skipped (cleanup skips the terminal):** `session-cleanup.sh` currently bails early when the sid is already gone from telepty, skipping the terminal-adaptor close → a telepty-orphaned-but-cmux-alive workspace lingers (verified live 2026-06-06: rec-coder-reconcile-2 workspace:47). Step 4 requires BOTH surfaces closed **regardless of telepty state**. telepty#17 DISCONNECTED accumulation is the downstream cost of skipping this.

---

## Step 5 — Propose the next task

Once cleanup is confirmed, invoke the `propose-next-task` skill (picks the next task from `state/task-queue.json` on an idle/blocked/awaiting turn) and propose from queue / stored context:

```bash
bin/tq-status.sh    # board state
bin/tq-focus.sh     # current focus / switch focus
```

Recommend parallel-eligible next tasks parallel-first (don't ask before recommending), but **fire only after user confirm**. End the turn with a one-line task summary (워크플로우 §5).

> **If skipped:** idle turn with no forward motion — the orchestrator stalls instead of conducting. Recommendation ≠ fire; proposing without confirm risks an unwanted wave.

---

## Known-limited surfaces (do not assume these exist this turn)

| Gap | Affects | Status |
|-----|---------|--------|
| #517 pull-AUTO_REPORT wiring | step 3 robustness | in-flight (rec-coder-reconcile-2) — until landed, manually pull git-log/transcript for any session that went silent |
| telepty-orphan terminal close (#323/#340) | step 4 completeness | in-flight — until landed, manually close the cmux workspace for any session that orphaned from telepty |
| #516 non-cmux host spawn | step 2 cross-terminal (§2) | queued — cmux works; other terminals unimplemented |

When a gap is open, the orchestrator covers the step manually (pull git-log for step 3, close the workspace by hand for step 4) and does not assume the automated path. These gaps are tracked in their own tasks; this skill does NOT reimplement them.
