---
name: orchestrate-turn
description: Use every orchestration turn. The canonical 5-step delegation loop — confirm context → spawn via terminal adaptor → handle clarifications → collect report → cleanup both surfaces → propose next. Rigid sequence; delegates to dispatch.sh / session-cleanup.sh / tq-*.sh / deliberation MCP. Does NOT reimplement actuation. Each step names the failure it prevents.
---

# orchestrate-turn

The orchestrator's per-turn delegation contract. **Rigid checklist** — run the steps in order, every turn, carrying shared turn context (which session, which task).

**This skill sequences; it does NOT actuate.** All actuation already lives at the atomic script layer (`bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh`, deliberation MCP). The skill owns only the ordering, gates, and human-in-the-loop checkpoints — it never reimplements spawn, inject, cleanup, or queue mutation. The orchestrator never writes `bin/` code itself (Rule 4/13) and never spawns/delegates outside this gated path (only the orchestrator delegates/spawns — ADR-MF #8 spawn-capability gate).

Read each step as a failure-mode tripwire: it states **what goes wrong if you skip it**.

## Step → infrastructure map (reused, never reimplemented)

Policy source: `docs/rules.md`; entrypoint and ownership map: `AGENTS.md`.
New prompts are additive unless the user explicitly changes existing scope (Rule 48).
Bind task work to its release group and component target as well (Rule 50). Keep
planned, included, published and installed-verified evidence distinct; a release
manifest check is not runtime execution authority or task completion.
Apply the actual spawn-time confinement gate before dispatch (Rule 46); a role cwd
is context isolation only. Policy text is not evidence that runtime gates are wired.

| Step | Action | Existing infra |
|------|--------|----------------|
| 1 | Confirm context with user | conversation; AskUserQuestion for ambiguity (multi-interpretation surface) |
| 1-1 | Break down → decide # sessions | `work-breakdown` skill (decompose to parallelizable tasks) + register via direct `state/task-queue.json` edit (jq); `bin/tq-track.sh`/`bin/tq-status.sh` read-only views |
| 1-2 | Parallel breakdown MANDATORY, conflict-aware | Rules 9/10/36: bundle tightly coupled same-task files; separate independent verification; parallelize independent units; same-file conflict or data dependency ⇒ sequential **with recorded reason**; ≥3 parallel ⇒ deliberation MCP |
| 1-3 | Match CLI to task | "CLI별 역할" table (claude=architecture/MCP, codex=impl/test, gemini=websearch/docs) → `--cli` / `--role` |
| 2 | Spawn + ref/inline + adaptor | `bin/dispatch.sh --spawn-and-dispatch --cli <c> --role <r> --ref <file> --task <id>` → `bin/open-session.sh` (`detect_terminal`) → `bin/lib/workspace-host.sh` adaptor |
| 2-1 | Session → orchestrator clarification | `telepty inject` HOLD → orchestrator |
| 2-2 | Orchestrator → user → re-inject | Ask only for a new Rule 47 decision; otherwise resolve within approved scope → `bin/dispatch.sh --target ... --task <id>` / short telepty ack |
| 2-3 | Session ↔ session communication | `bin/ask.sh` structured information-only exchange (#533 guardrail); no peer work delegation |
| 3 | REPORT + evidence recovery | Scoped `telepty inject` push; reconcile `check` observations/HOLD and separate `report-sweep` recovery are not worker REPORT acceptance/ACK |
| 4 | Review → preserve → cleanup BOTH | Rule 28 autonomous cleanup → `bin/session-cleanup.sh <sid>`; protect orchestrator and ancestors |
| 5 | Propose next task | `propose-next-task` skill + `bin/tq-status.sh` / `bin/tq-focus.sh` + `state/task-queue.json` + stored context |

---

## Step 1 — Confirm context with the user

Confirm the working context before any breakdown. Preserve earlier requests and in-flight work when a new prompt arrives; link additions or explicit revisions to their owning tasks (Rule 48). On ambiguity, surface N interpretations and ask (AskUserQuestion / multi-interpretation surface) — never silently pick one (응답 원칙 §4).

**Run the ambiguity gate here, BEFORE 1-1** (Rule 37, HARD): if ≥2 competing readings survive reading and the residual difference is about the user's *intent* rather than repo *facts*, `EnterPlanMode` with those interpretations as the plan's §1 and change no state until approved — breakdown, task registration, and dispatch all wait behind the gate. `AskUserQuestion` stays the asking mechanism *inside* plan mode.

> **If skipped:** you delegate against a guessed intent. The whole wave runs on the wrong target and burns N sessions before the mistake surfaces.

### 1-1 Break down → decide # sessions
Decompose the confirmed work into bounded task/contract units. Apply Rules 9/10 (user approval 2026-09-19): one confined implementation worker may own tightly coupled files for the same task; record the exact file set and coupling reason. Keep independent testing and review with separate workers. Bind each unit to its existing owning task; create a task only when no owner exists, not for each file or verification session. `bin/tq-track.sh` and `bin/tq-status.sh` are read-only views; `bin/tq-focus.sh` only sets `.active_focus`. Decide session count from independent work, not file count.

> **If skipped:** no task-queue trail → step 5 has nothing to propose from, and reconcile cannot reconcile dispatches it never saw.

### 1-2 Parallel breakdown is MANDATORY, conflict-aware
Parallel is the default for independent executable units (**Rule 36**, revised 2026-09-19). Before ANY dispatch, identify tightly coupled same-task file sets and independent units; dispatch the latter **concurrently, in one wave**. Do not split a coupled implementation solely because it touches multiple files, or merge independent verification into its implementation worker. Sequential execution between units requires (a) same-file / same-resource conflict or (b) intrinsic data dependency (A's output = B's input), recorded in the task note or dispatch log. Each file has one active writer; ownership transfer requires the prior writer to stop and its artifact to be preserved. Keep **worktree isolation**, actual task/sid/attempt confinement, **task-id-based unique `--track`**, and deliberation MCP for ≥3 parallel sessions. Bundling never authorizes a worker to widen its scope. Approved-scope composition remains autonomous; new Rule 47 decisions still require user confirmation.

> **If skipped:** an undecomposed monolith goes to one session and independent work serializes into pure wall-clock waiting (Rule 36 violation), or a sequential wave leaves no recorded reason to audit. Two sessions edit the same file → merge corruption / lost work. Shared `--track` → shared-fate cascade-kill. ≥3 parallel without deliberation → no conflict detection, silent divergence.

### 1-3 Match the CLI to the task
Fresh dispatches use the model router by default; explicit `--cli` overrides it. Within an approved task, choose CLI/model/effort/role/session/parallel composition and deliberation participants autonomously using task fit, verified capability, availability, confinement and budget limits (Rule 6, 2026-09-12). Preserve valid user overrides and briefly record the rationale; do not ask the user to pick workers on every wave. Record delegated/controller selection honestly, never as a fabricated human UI click or authority proof. Pass `--role` for context isolation; separately verify actual task/sid/attempt confinement (Rule 46). New scope, purchases, private transfer, destructive actions and authority changes still require Rule 47 decisions.

> **If skipped:** `--role` omitted → worker auto-discovers cwd CLAUDE.md and self-IDs as orchestrator (#431 regression). Wrong CLI → low-quality output you re-delegate anyway.

---

## Step 2 — Spawn via the terminal adaptor + inject context

First confirm the full 위임 전 체크리스트 (approved task/scope, controller-selected target, MANDATORY report path, [SAWP] envelope, lessons, SPEC FIRST, self-contained ref). Do not repeat user approval for ordinary worker composition within that scope. Then spawn via the dispatch helper, never raw spawn (Rule 32 HARD). `--spawn-and-dispatch` carries context through a **ref file**; raw telepty is only for permitted short acknowledgements/follow-ups.

```bash
bin/dispatch.sh --spawn-and-dispatch --track <T> --name <N> --cwd <P> \
  --cli claude --role <role> --ref <ref-file> --from <orch-sid> --task <id> [--verify-delivered]
# Rule 34 task-gate (#736): --task <id> must name a registered task in
# state/task-queue.json (a confirmed dispatch auto-sets it to `delegated`).
# Exempt work uses --no-task "<reason>" — audited to ~/.aigentry/telemetry/.
```

`dispatch.sh` registers the dispatch in `state/dispatch/active.json` (the pull-report registry), boots the role-sandbox cwd, and routes through `open-session.sh` (`detect_terminal`) → `workspace-host.sh` adaptor. The skill does NOT spawn terminals directly. After dispatch, **verify started-working** (Rule 33): CONNECTED + ready + clean + moving — `delivered ≠ started`.

> **If skipped:** raw `telepty inject` spawn → no `active.json` row → #517 pull-fallback has nothing to pull → if the REPORT push fails, the dispatch is invisible forever. Skipping Rule 33 verify → you proceed believing a garbled/stuck session is working.

### 2-1 Session → orchestrator clarification
A worker that needs clarification injects a HOLD question back to the orchestrator and **waits** — it does not self-progress past the boundary (`telepty inject` HOLD → orchestrator).

> **If skipped (HOLD-ignored self-progress):** the worker invents an answer and builds the wrong thing — a §13 violation. Enforce explicit HOLD inject; never let a session guess past a HOLD.

### 2-2 Orchestrator → user → re-inject
Resolve technical questions within the existing contract as the orchestrator. Ask the user only for the specific unresolved intent, architecture, destructive action, cost, privacy or authority decision (Rule 47); preserve the answer and revision in its task and hold only dependent work. Then re-inject through `bin/dispatch.sh --target <sid> --ref <file> --task <id>` for a ref payload, or `telepty inject` for a short inline ack. Do not resume an unrestricted worker just to deliver a policy update.

Complete the round trip: preserve the explicit human decision, relay it to the exact
worker via task-bound telepty dispatch, then verify an acknowledgement matching the
decision/task/sid/attempt/operation/scope revision before treating the dependent work
as resumed. A user answer alone is not delivery. Record rejection, revision, stale
authority and delivery/ACK failure explicitly; retry without duplicate execution.
This required #1136/#1170 release gate is not implemented by editing this skill.

> **If skipped:** you answer a business/UX question yourself → answer diverges from user intent → the worker's output is rejected at review.

### 2-3 Session ↔ session communication — INFORMATION-ONLY (invariant)

Session-to-session information exchange must use the sanctioned `bin/ask.sh` structured request/reply channel, with its three-round cap (#533). Raw peer inject is not the sanctioned channel. Information exchange MUST NOT delegate implementation or any work between sessions.

- ✅ **Allowed:** a session asks another session for information/context it needs.
- ❌ **Forbidden:** a session delegating implementation/work to another session.
- If implementation IS needed, route through the orchestrator: **requesting-session → orchestrator scope check → user decision only if Rule 47 requires it → orchestrator dispatch**. Ordinary worker selection within approved scope is autonomous; sessions never delegate work to peers.

This preserves spawn-capability gating (only the orchestrator delegates/spawns; ADR-MF #8) while granting the user's requested direct info exchange.

**Guardrail (anti-§13-loop):** direct session↔session info exchange is capped at **3 rounds**. If it turns into multi-round debate or surfaces a conflict, escalate to **deliberation MCP** (≥3 parties) or back to the orchestrator.

> **If skipped (2-3 turns into work-delegation):** a session hands implementation to a peer, bypassing spawn-capability gating and human-in-the-loop. No orchestrator visibility, no user confirm, no `active.json` row — an ungoverned shadow dispatch. The 3-round cap + info-only rule exist to stop exactly this.

---

## Step 3 — Collect the REPORT (push-primary + pull-fallback)

Rule 49 (2026-09-12): all inter-session message delivery must use telepty. Durable
report files preserve evidence and retry payloads; manual file reads are not
telepty delivery or receiver acknowledgement. An isolated worker needs scoped
task/sid/attempt/destination authority, not the host's unrestricted control token.
Do not spoof a worker sender or describe a controller relay as an actual worker
push. Record blocked/unknown transport honestly. The confined outbox/telepty
integration is incomplete (#1170/#1136); this skill update does not wire it.

The worker pushes its REPORT via the scoped `telepty inject` path when available. Do **not** depend solely on the push: preserve and recover evidence when transport is blocked or uncertain. The selected `src/reconciler/cli.ts` describes `check` as observations/HOLD, never completion, and separately invokes `report-sweep` to recover report references. `src/tracker/report-sweep.ts` explicitly says `NEW` is an inbox notification, not report-acceptance ACK. Existing policy describes two absent ticks as a `session_gone` observation and HOLD only; the exact tracker `check` implementation is not supplied in this bounded source set, so that runtime behavior remains unverified. A gone, unreported row does not guarantee AUTO_REPORT. Recovery, worker authorship/attempt validation, transport receipt, REPORT review/acceptance and semantic ACK are separate evidence states; retain unknown where evidence is missing.

> **If skipped (telepty-orphan no-report):** you wait forever for a push that silently failed. The session finishes, the workspace orphans, and nothing reports completion. Always treat step 3 as push + pull, never push-only.

---

## Step 4 — Review → preserve → cleanup BOTH surfaces

Review the REPORT against the spec and verify artifact preservation in the worktree, main tree and named remote branch (record absent copies honestly). Once the report is verified and preserved, the artifact is preserved and only speculative standby remains, clean up autonomously under Rule 28; do not ask permission again. First verify exact sid/attempt ownership of both cleanup targets and that the target sid and allow PID are neither the orchestrator, its bridge nor its ancestors. Immediate concrete phase reuse is an exception, not indefinite standby. The protected helper must close **both** surfaces:

```bash
bin/session-cleanup.sh <sid>
```

This runs parent-PID SIGTERM + telepty session DELETE + the cmux/terminal `close-workspace`. A session is not "cleaned" until both surfaces are gone — terminal surface ownership is the orchestrator adaptor, not telepty (Rule 28).

> **If skipped:** a telepty-orphaned-but-terminal-alive workspace can linger. This occurred on 2026-06-06 at rec-coder-reconcile-2/workspace47; that historical observation is not a claim about today's cleanup implementation. Verify BOTH surfaces regardless of prior telepty state. telepty#17 DISCONNECTED accumulation is the downstream risk.

---

## Step 4-A — Write the context delta into its task (Rule 40)

Before step 5, any context from this turn that **differs from what the task already
records** goes onto that task, not into chat only:

```bash
# append a dated segment to the OWNING task's note in state/task-queue.json
# new task only when no existing task owns the context
```

Name what was measured and what was not (Rule 38). Closing messages and record-only
reports count — they are the ones that otherwise survive nowhere.

> **If skipped:** the turn's best finding lives only in the transcript and dies at the
> next compact. Measured 2026-08-26/27: a shipped-unverified feature, a delivery check's
> two failure modes, and a wrong attribution all arrived this way. tq#1068.

---

## Step 5 — Propose the next task

Once cleanup is confirmed, invoke the `propose-next-task` skill (picks the next task from `state/task-queue.json` on an idle/blocked/awaiting turn) and propose from queue / stored context:

```bash
bin/tq-status.sh    # board state
bin/tq-focus.sh     # current focus / switch focus
```

Recommend parallel-eligible next tasks parallel-first. Continue approved eligible work without repeat composition approval; ask before starting unapproved scope or crossing a Rule 47 boundary. Recommendations never activate Task Loop. End with a one-line task summary.

> **If skipped:** approved work stalls or new scope runs without authority. Operational selection authority is not unlimited execution authority.

---

## Historical gaps (re-measure before use)

The rows below describe 2026-06-06 observations, not current implementation status.
Check the owning task, source caller and live outcome before relying on a gap or fix.

| Gap | Affects | Status |
|-----|---------|--------|
| #517 pull-AUTO_REPORT wiring | step 3 robustness | in-flight (rec-coder-reconcile-2) — until landed, manually pull git-log/transcript for any session that went silent |
| telepty-orphan terminal close (#323/#340) | step 4 completeness | in-flight — until landed, manually close the cmux workspace for any session that orphaned from telepty |
| #516 non-cmux host spawn | step 2 cross-terminal (§2) | queued — cmux works; other terminals unimplemented |

When a gap is open, the orchestrator covers the step manually (pull git-log for step 3, close the workspace by hand for step 4) and does not assume the automated path. These gaps are tracked in their own tasks; this skill does NOT reimplement them.
