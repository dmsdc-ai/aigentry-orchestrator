# Canonical Orchestration Sequence — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
> **In the aigentry environment**, "worker" = a telepty session dispatched via `bin/dispatch.sh` (dogfooding the very sequence this plan codifies). Doc chunks (1–2) are orchestrator-authored self-governance; code chunks (3–4) MUST be delegated to a `coder` session (Rule 4/13 — orchestrator never writes `bin/` code).

**Goal:** Codify the orchestrator's 5-step turn-loop as a single `orchestrate-turn` skill + ADR + AGENTS.md amendment, mapped 1:1 to existing infra, and close the two infra gaps the sequence depends on (#517 pull-report + telepty-orphan cleanup).

**Architecture:** One cohesive behavioral skill delegating to the already-atomic script layer (`dispatch.sh`, `session-cleanup.sh`, `tq-*.sh`, deliberation MCP). Progressive disclosure (`references/`) only when a step earns it. Code gaps reuse existing machinery: `dispatch-tracker.sh` already has AUTO_REPORT — wire it into the reconcile tick; fix the active.json registration + cleanup early-bail.

**Tech Stack:** Markdown (skill/ADR/AGENTS.md), pure POSIX/bash shell (bin/), bats-style shell test harness under `tests/`.

**Spec:** `docs/superpowers/specs/2026-06-06-orchestration-sequence-design.md` (approved).

---

## Chunk 1: orchestrate-turn skill (orchestrator-authored)

**Files:**
- Create: `.agents/skills/orchestrate-turn/SKILL.md`
- Create symlink: `.claude/skills/orchestrate-turn -> ../../.agents/skills/orchestrate-turn`

- [ ] **Step 1: Write `SKILL.md` frontmatter + body**

Frontmatter (match existing convention — `name` + `description` only):
```markdown
---
name: orchestrate-turn
description: Use every orchestration turn. The canonical 5-step delegation loop — confirm context → spawn via terminal adaptor → handle clarifications → collect report → cleanup both surfaces → propose next. Rigid sequence; delegates to dispatch.sh / session-cleanup.sh / tq-*.sh / deliberation.
---
```
Body sections (rigid checklist, one per step) — copy the step→infra mapping table from the spec verbatim, then per step give the exact command form:
- Step 1 / 1-1 / 1-2 / 1-3: confirm context; break down → # sessions (`tq-track.sh`); parallel-first, conflict-aware (Rule 9 file-separation → sequential on conflict; ≥3 ⇒ deliberation); CLI match (`--cli`/`--role`).
- Step 2 / 2-1 / 2-2 / 2-3: `dispatch.sh --spawn-and-dispatch --cli <c> --role <r>` + `--ref` (long) / inline (short); clarify→orchestrator HOLD; orchestrator→user→re-inject; **2-3 invariant verbatim** (info-only, no work delegation, impl routes orchestrator+human, 3-round cap → deliberation).
- Step 3: push REPORT + #517 pull-fallback (the reconcile tick).
- Step 4: review → user-confirm → `session-cleanup.sh <sid>` (BOTH telepty + terminal adaptor).
- Step 5: `tq-status.sh`/`tq-focus.sh` propose next.
Include a "Known-limited surfaces" note pointing at gaps #516 (non-cmux), and (until Chunk 3–4 land) #517/cleanup.

- [ ] **Step 2: Create the symlink**

Run: `ln -s ../../.agents/skills/orchestrate-turn .claude/skills/orchestrate-turn`
Expected: `ls -l .claude/skills/orchestrate-turn` shows the symlink resolving.

- [ ] **Step 3: Verify the mapping (the test)**

Run a grep that asserts every command named in the skill exists:
```bash
for c in bin/dispatch.sh bin/session-cleanup.sh bin/tq-track.sh bin/tq-status.sh bin/tq-focus.sh; do test -x "$c" || echo "MISSING: $c"; done
```
Expected: no `MISSING` lines.

- [ ] **Step 4: Commit**
```bash
git add .agents/skills/orchestrate-turn/SKILL.md .claude/skills/orchestrate-turn
git commit -m "feat(skill): add orchestrate-turn canonical sequence skill"
```

---

## Chunk 2: ADR + AGENTS.md amendment (orchestrator-authored)

**Files:**
- Create: `docs/adr/2026-06-06-orchestration-sequence.md`
- Modify: `AGENTS.md` (the "세션 간 자유 토론" rule + add a "표준 오케스트레이션 시퀀스" section)

- [ ] **Step 1: Write the ADR**

Status accepted, date 2026-06-06. Sections: Context (the 5-step directive + "must reuse existing infra"), Decision (one skill + progressive disclosure; the step→infra table; the 2-3 info-only amendment + rationale: preserves spawn-capability gating ADR-MF #8 while granting direct info exchange; 3-round cap), Consequences (gaps tracked: #517, #516, cleanup-orphan #323/#340), the live orphan incident (2026-06-06 rec-coder-reconcile-2 workspace:47) as the empirical justification.

- [ ] **Step 2: Amend the AGENTS.md session↔session rule**

Modify the existing line (AGENTS.md:~99, "세션 간 자유 토론: deliberation 경유 필수. 세션 간 직접 inject 금지."):
New text: `세션 간 통신: **정보 확보 목적의 직접 telepty inject 허용** (read-only). 구현/작업 위임 금지 — 구현 필요 시 오케스트레이터 경유 → 사용자 확인(HITL) → 오케스트레이터가 위임. 3라운드 초과 또는 충돌 시 deliberation 에스컬레이션.`

- [ ] **Step 3: Add the sequence section to AGENTS.md**

Under "## 워크플로우", add "### 표준 오케스트레이션 시퀀스" linking `orchestrate-turn` skill + the step→infra table (or a one-line pointer to the skill to stay DRY).

- [ ] **Step 4: Verify links resolve**
Run: `test -f docs/adr/2026-06-06-orchestration-sequence.md && grep -q orchestrate-turn AGENTS.md && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**
```bash
git add docs/adr/2026-06-06-orchestration-sequence.md AGENTS.md
git commit -m "docs(adr): canonical orchestration sequence + 2-3 session-comms amendment"
```

---

## Chunk 3: #517 pull-AUTO_REPORT wiring + active.json registration (DELEGATE → coder, TDD)

**Files:**
- Modify: `bin/dispatch-tracker.sh` (add a `register` subcommand — single owner of `active.json`)
- Modify: `bin/dispatch.sh` (call `dispatch-tracker.sh register …` after a successful spawn+inject)
- Modify: `bin/session-reconciler.sh` (invoke `dispatch-tracker.sh check` per tick)
- Reuse: `bin/dispatch-tracker.sh:119 _mutate_state` (fcntl.flock locked write over `$ACTIVE_JSON`) + the AUTO_REPORT logic at `:363-386` — do NOT reimplement either.
- Test: `tests/dispatch/T30_dispatch_registration.sh`, `tests/dispatch/T31_autoreport_wiring.sh` (flat `T<N>_*.sh`, sourcing `tests/dispatch/lib.sh`, auto-discovered by `run-all.sh`)

> **Registry fact (verified):** `active.json` (`$ACTIVE_JSON`) IS the tracker's registry — mutated only through `_mutate_state` (fcntl.flock). The gap: `dispatch.sh` never writes to it (`grep active.json bin/dispatch.sh` → nothing), so the registry stays `[]` and `check` finds nothing to AUTO_REPORT. Keep `active.json` single-owner: registration goes through a new tracker `register` subcommand, NOT a direct write from `dispatch.sh` (DRY, lock-consistent).

- [ ] **Step 1 (test, registration): write failing test**
`tests/dispatch/T30_dispatch_registration.sh` (source `lib.sh`): call `dispatch-tracker.sh register <sid> --track T --role coder --cwd P --branch B` against a temp `ACTIVE_JSON`; assert the entry appears with `status=in_flight, reported=null`; call it again with the same sid → assert idempotent (no duplicate).
Run: `bash tests/dispatch/T30_dispatch_registration.sh` → Expected: FAIL (no `register` subcommand).

- [ ] **Step 2 (impl, registration): add the `register` subcommand**
In `bin/dispatch-tracker.sh`, add `cmd_register()` dispatched from the arg parser (alongside `mark-reported`), writing via the existing `_mutate_state` lock: upsert `{sid,track,role,cwd,branch,started_at,status:"in_flight",reported:null}` (idempotent on sid). Then in `bin/dispatch.sh`, after a successful `--spawn-and-dispatch` spawn+inject, invoke `dispatch-tracker.sh register …` (best-effort; a registration failure must not fail the dispatch).
Run test → Expected: PASS.

- [ ] **Step 3 (test, wiring): write failing test**
`tests/dispatch/T31_autoreport_wiring.sh` (source `lib.sh`). **Scope: the reconciler-tick → tracker-invocation seam ONLY** — NOT the tracker's emission logic (that is owned by `T8_pull_auto_report.sh`; do not duplicate it). Stub `dispatch-tracker.sh` with a spy that records it was called, seed one tick, assert the reconciler tick invoked `dispatch-tracker.sh check` (best-effort, honoring `DRY_RUN`).
Run: `bash tests/dispatch/T31_autoreport_wiring.sh` → Expected: FAIL (tick does not call the tracker).

- [ ] **Step 4 (impl, wiring): wire tracker into the tick**
In `bin/session-reconciler.sh` tick, call `dispatch-tracker.sh check` (best-effort, never blocks the sweep, honors `DRY_RUN`). Conservative behavior is already in the tracker: no git evidence ⇒ leaves `reported=null` (do not fabricate); idempotent via existing `auto-reports.seen`.
Run test → Expected: PASS.

- [ ] **Step 5: `bash -n` + full suite + commit (separate commits per logical step; do NOT push)**
```bash
bash -n bin/dispatch.sh bin/dispatch-tracker.sh bin/session-reconciler.sh
bash tests/dispatch/run-all.sh          # T30 + T31 + existing suite (incl. T8) all green
git add -A && git commit -m "feat(dispatch): register dispatches in active.json + wire pull-AUTO_REPORT into reconcile tick (#517)"
```

---

## Chunk 4: session-cleanup telepty-orphan terminal-cleanup (DELEGATE → coder, TDD)

**Files:**
- Modify: `bin/session-cleanup.sh:158-169` (telepty-miss branch `return 0` at :162-163 fires before `wh_close_for_sid`-style close at :169 — verified)
- Test: `tests/dispatch/T32_cleanup_orphan_terminal.sh` (flat `T<N>_*.sh`, sourcing `tests/dispatch/lib.sh`, auto-discovered by `run-all.sh` — no separate `tests/session-cleanup/` dir exists; follow the flat convention)

- [ ] **Step 1 (test): write failing test**
`tests/dispatch/T32_cleanup_orphan_terminal.sh` (source `lib.sh`): stub telepty so the sid is ABSENT from `list`, and stub `wh_close_for_sid` (`workspace-host.sh:470`) / the cmux CLI to record a close call. Run `session-cleanup.sh <sid>`; assert the terminal-adaptor close WAS invoked despite the telepty miss.
Run: `bash tests/dispatch/T32_cleanup_orphan_terminal.sh` → Expected: FAIL (current `return 0` at :162-163 skips the close).

- [ ] **Step 2 (impl): always run terminal-adaptor close**
Change the telepty-miss branch so it still invokes the terminal-adaptor close + the DELETE backup before returning success. **Correctness trap:** on a telepty-orphan the session JSON (`$info`) is EMPTY, so the existing `close_workspace_for <sid> <info>` would silently no-op — derive the workspace title from the **`sid`** (call `wh_close_for_sid "$sid"` directly), not from the absent `$info`. Keep orchestrator-protection (`--force`) + idempotency intact. (Line cite may have drifted — `grep -n "already cleaned or never registered" bin/session-cleanup.sh` to locate the exact `return 0` branch rather than trusting a line number.)
Run test → Expected: PASS.

- [ ] **Step 3 (regression): existing suite still green**
Run: `bash tests/dispatch/run-all.sh` → Expected: all PASS (incl. T27 sole-close-idempotent, T28 protected-push-guard).

- [ ] **Step 4: `bash -n` + commit (do NOT push)**
```bash
bash -n bin/session-cleanup.sh
git commit -am "fix(session-cleanup): close terminal adaptor even when session is telepty-orphaned (#323/#340)"
```

---

## Execution order & handoff

1. **Chunk 1–2** (docs): orchestrator authors directly (self-governance contract; not `bin/` code). Land on `main`.
2. **Chunk 3–4** (code): delegate to ONE `coder` session via `dispatch.sh --spawn-and-dispatch --cli claude --role coder`, sequenced (Chunk 3 → HOLD → Chunk 4) — file scopes don't overlap, but the HOLD lets the orchestrator verify #517 before the cleanup fix. Self-contained dispatch ref per `docs/templates/dispatch-ref-template.md`.
3. Orchestrator verifies each REPORT (now via the freshly-wired pull-AUTO_REPORT — dogfooding), confirms with user, then `session-cleanup.sh` (step 4).

**Verification (whole plan):** skill exists + mapping-grep clean; ADR + AGENTS.md links resolve; `bash tests/dispatch/run-all.sh` green including new T30 (registration), T31 (autoreport tick-wiring), T32 (orphan terminal close) and all pre-existing T1–T29.
