---
type: adr
status: proposed
scope: ecosystem
decision_type: two-way
tier: T2
date: 2026-07-26
author: aigentry-architect-claude (a759m-ambiguity-adr)
tags: [plan-mode, ambiguity, skill, rule-37, hitl, devkit, article-17, context-preservation]
supersedes: []
related:
  - "docs/adr/2026-07-26-hitl-gate-primitive.md (worker-side human surface — the branch this ADR routes workers to)"
  - "docs/adr/2026-07-26-skill-ownership-routing.md (§2 tiebreak — applied here to place the skill in devkit)"
  - "docs/adr/2026-06-06-orchestration-sequence.md (orchestrate-turn step 1 — the insertion point)"
related_tasks: [759, 760, 743, 737, 740]
---

# ADR 2026-07-26 — Ambiguity Gate: a plan-mode gate for watched surfaces, a HOLD for unwatched ones

## §1 Context

### §1.1 The directive

User, 2026-07-26 (verbatim):

> "태스크에 모호함이 있을때는 항상 무조건 plan mode로 동작하도록 해줘. 이것도 스킬로 만들어줘."

Resolved in plan-mode Q&A. Four decisions are **USER-CONFIRMED inputs**, not open questions:
role-dual application, three enforcement surfaces (skill + HARD rule + checklist row),
unconditional firing on task-shaped requests, and a 2-track context-blocking fix.

**One interpretive ruling is required before anything else.** "무조건" is ambiguous between
*(i)* every task enters plan mode and *(ii)* every **ambiguous** task enters plan mode, without
exception or discretion. The directive's own subordinate clause — "모호함이 **있을때**" — plus the
confirmed 발동 경계 row ("task-shaped requests only; non-task chatter/1-line acks excluded") fix
it on **(ii)**. "무조건" binds to *the response, given ambiguity* — it removes the agent's
discretion to proceed on a guess, not the ambiguity precondition. Alternative C (§3.3) records
why reading (i) is rejected rather than merely unchosen.

### §1.2 What exists today

| Capability | Already exists | Location | Gap |
|---|:-:|---|---|
| "Surface N interpretations, never silently pick one" | **YES** | `AGENTS.md` 응답원칙 §4 | Reply-level prose. Nothing prevents the agent from surfacing N *and then acting anyway* in the same turn. |
| "Spec 모호 시 multi-interpretation surface" as a legitimate user-interaction class | **YES** | `docs/rules.md` Rule 30, 사용자 인터렉션 정당 영역 table | Names the class; specifies no mechanism. |
| Ambiguity handling in the per-turn loop | **YES** | `.agents/skills/orchestrate-turn/SKILL.md` Step 1 ("On ambiguity, surface N interpretations and ask") | Same gap — no gate; step 1-1 breakdown may begin in the same turn. |
| Worker-side "do not guess past a boundary" | **YES** | `docs/sawp.md` HOLD protocol + `CONTEXT.md` **HOLD inject** | Convention. Structure arrived only 2026-07-26 via the HITL Gate. |
| Structured, resumable human decision point | **YES** | `bin/hitl.sh` + `state/hitl/` (ADR 2026-07-26-hitl-gate-primitive, #744 landed) | Built for unwatched surfaces. No interactive counterpart. |
| Blocking-before-action harness primitive | **YES** | Claude Code native plan mode (`EnterPlanMode` / `ExitPlanMode`) | Never referenced anywhere in `docs/`, `AGENTS.md`, or `CLAUDE.md` (grep: 0 hits). Unused capability. |
| Broad-request heuristic | **YES** | oh-my-claudecode `config/CLAUDE.md` PART 5 "Broad Request Detection" | External plugin — Art.17.2 optional, cannot be a dependency. |
| **A decidable ambiguity test** | **NO** | — | ← gap 1 |
| **A gate that blocks action until the interpretation is chosen** | **NO** | — | ← gap 2 |
| **A rule that survives the agent's own judgment** | **NO** | — | ← gap 3 |

Every ingredient exists. What is missing is a *predicate*, a *gate*, and *normativity*. This ADR
adds one of each and reuses everything else.

### §1.3 Evidence — the precondition, ratified with a correction

The 발동 경계 row makes unconditional firing conditional on "the plan-mode context-blocking fix."
The dispatch asks this session to **ratify or refute with evidence**. Verdict: **RATIFIED, with a
correction to its scope and a rejection of its blocking status.**

| Ref | Evidence | Bearing |
|---|---|---|
| **#737** (done, 2026-07-26) | Proven mechanism class: a blocking modal swallows inject text and consumes the CR — `--submit-force` bypassed the `codex_modal_ui` check (`daemon.js:3045-3050`). Live proof: pre-fix = inject false-success + wrong command executed + session death. | Establishes that **a modal surface silently destroys injects**. Plan mode is a modal surface. |
| **#743** (P1, pending) | Three worker REPORT injects lost the same morning — `a739s` 09:49, `c738r` 09:56, `c737r` 09:57 — while the orchestrator was in "연속 tool-call 작업 + **plan mode**". One contained a production daemon incident disclosure; recovered only by a manual `~/.telepty/shared` mtime scan after the user noticed. | **Direct evidence** that plan mode participates in the loss. Also shows the loss is **not exclusive** to plan mode — busy tool-call turns lose injects too. |
| **#760** (delegated, `c760m`) | User's `AskUserQuestion` answer had `d749p`'s REPORT text **spliced into it**. Extends #737's positional last-signal-wins gate to Claude modal surfaces. | The Track-1 fix. Necessary. |

**Correction.** The proposal treats #760 as *the* precondition. The evidence says the loss is
**modal-class and busy-PTY-class**, of which plan mode is one member — so #760 is **necessary but
not sufficient**, and a rule that waits for it would be waiting for the wrong sufficient condition.

**Consequence for this design:** the dependency on #760 must be **graceful**. Track 2 (§2.3) makes
the gate safe standalone by recovering the high-value loss class from disk. The gate ships before
#760 lands; #760 shrinks the residue it has to recover.

## §2 Decision

Add **one skill — `ambiguity-gate`** — carrying a decidable ambiguity test and a two-branch
response, made normative by **`docs/rules.md` Rule 37** and surfaced by one **AGENTS.md checklist
row**. No new script, no daemon, no dependency.

**Thesis.** The branch variable is not the session's role. It is **whether a human is watching the
surface on which the question would appear.** Plan mode is a blocking modal: on a watched surface
it is the cheapest possible gate; on an unwatched one it is indistinguishable from a hung session
— and, per #737/#760, it *eats* the injects sent to wake it. Role is the observable proxy for
"watched", nothing more. Every other choice below follows from that one sentence.

### §2.1 The ambiguity test — two gates, and one rule that makes them reproducible

**Gate A — is this task-shaped?** (scope filter; all must hold)

The request asks for a change to durable state (files, config, running systems, dispatched work)
or for a deliverable artifact (doc, design, report). Excluded, enumerated:

| Excluded class | Example |
|---|---|
| Answerable from context already loaded | "what did #743 conclude?" |
| Status / read-only query | "which sessions are alive?" |
| 1-line ack, follow-up, `send-key`, broadcast | "ok", "go", "yes do that" |
| Preference / tone / mode directive | "caveman mode", "shorter answers" |
| Conversation about a decision already made | "why did we pick two-way?" |

Enumerating exclusions is deliberate: a positive definition of "task" drifts between readers, a
closed exclusion list does not.

**Gate B — is it ambiguous?** Fires if **≥1** signal holds:

| # | Signal | Firing test |
|---|---|---|
| **A1** | **Target** | ≥2 concrete referents in the repo match the named target and the request does not disambiguate |
| **A2** | **Scope** | The change boundary has ≥2 defensible cut points (this call site / this module / every caller) |
| **A3** | **Deliverable** | You cannot name the exact file(s) or artifact(s) that will exist when it is done |
| **A4** | **Success criteria** | You cannot state one checkable pass/fail condition |
| **A5** | **Unbounded destructive op** | delete / overwrite / push / publish / reset / kill without an explicit bound (which files, which remote, which sessions). **Fires alone, always** |
| **A6** | **Vague verb, no target** | improve / enhance / fix / refactor / 정리 / 개선 with no named file, function, or symbol |
| **A7** | **Constraint conflict** | Proceeding requires choosing which standing rule, ADR, or constitutional article to violate |

A6 is the oh-my-claudecode "Broad Request Detection" heuristic, cited rather than reinvented
(Art.1 경량; the heuristic is sound, only its plugin coupling is unacceptable — §3.2).

**The write-two rule — what makes this reproducible.** A signal fires **only if you can write
down the ≥2 competing readings verbatim.** Suspicion is not a signal. If you can produce two, you
may not silently pick one (AGENTS.md 응답원칙 §4); if you cannot produce two, the signal did not
fire and you proceed.

This is the whole mechanism for inter-reader agreement, and it pays twice: the written
interpretations *are* the first section of the plan, so detecting the ambiguity and drafting the
plan are the same act — no extra work, and the plan cannot be vaguer than the detection.

**The resolve-by-reading brake — what makes it survivable.** Cheap disambiguation comes **first**.
If ~3 tool calls (a grep, a file read, a `tq-status`) resolve the referent, it was never ambiguous
and the gate must not fire. Only **residual ambiguity that survives reading** triggers the gate.

Without this brake, "무조건" degenerates into an interview before every task, users learn to
approve without reading, and the gate becomes a tax that buys nothing. It is the single most
important line in §2.1 and the first thing M1 (§8) measures.

**Decision rule:** `Gate A pass AND (≥1 of A1–A7 survives reading) → ambiguous`.

### §2.2 Branch by watched surface — and how the skill knows

| Branch | Condition | Action |
|---|---|---|
| **Interactive** | human watching this surface | `EnterPlanMode` → plan whose §1 is the written interpretations + recommendation → wait for approval → `ExitPlanMode` → act |
| **Dispatched worker** | nobody watching | **MUST NOT enter plan mode.** `telepty inject` **HOLD** to orchestrator with the same written interpretations + recommendation → wait. Orchestrator opens a HITL Gate (`bin/hitl.sh open --kind decision --resume reinject`, ADR 2026-07-26 producer (c)) → `awaiting_user` → resume by re-inject |

**Detection signal: `AIGENTRY_WORKER_SESSION`.** Set to `1` by `bin/dispatch.sh:117` in the
generated per-session `worker-launcher.sh`, for **all** CLIs (`dispatch.sh:565`: "so codex/claude/
gemini all receive `AIGENTRY_WORKER_SESSION`"). Already load-bearing as the orchestrator-vs-worker
discriminator at `bin/session-cleanup.sh:323`, with a regression test
(`tests/dispatch/T34_cleanup_worker_guard.sh`) and a fixture guard (`tests/dispatch/lib.sh:14`).

Verified empirically: this architect session — spawned via `--spawn-and-dispatch --role architect`
through `boot-prepare.mjs` — carries `AIGENTRY_WORKER_SESSION=1`.

Signals considered and rejected:

| Signal | Rejected because |
|---|---|
| role-sandbox cwd (`~/.aigentry/role-sandbox/<role>-<sid>/`) | **Empirically wrong.** The boot contract instructs the worker to `cd $AIGENTRY_TARGET_CWD`; this session's `PWD` is the target repo, not the sandbox. Also path string-matching breaks under a relocated `AIGENTRY_HOME`. |
| `[SAWP]` envelope / dispatch-ref receipt | Conversational, not observable to a skill; absent on follow-up injects. |
| `AIGENTRY_TARGET_CWD` | Works, but is a side effect of cwd decoupling, not a purpose-built discriminator. One signal is enough (Art.1). |
| `TELEPTY_SESSION_ID` | Present for the orchestrator too — does not discriminate. |

**Default when unset ⇒ interactive.** Deliberately fail-open, and the asymmetry is the reason:

- A false *worker* verdict on the orchestrator silently removes the user's own gate — reintroducing
  exactly the failure the directive exists to eliminate, invisibly.
- A false *interactive* verdict on a worker produces a plan-mode stall on an unwatched screen —
  bad, but **already instrumented**: `dispatch-tracker.sh check` classifies it and AUTO_REPORTs or
  re-dispatches within the 30-minute window.

A public devkit user running `claude` directly has no env var and *is* interactive. The default is
correct for them by construction.

### §2.3 Context-preservation contract (Track 2)

The skill's plan-mode steps **mandate** a shared-ref sweep. Three points: **entry** (drop marker),
**each user-turn boundary** during a multi-turn interview, and **exit before acting** on the
approved plan.

**The proposed command does not work here.** The dispatch specifies
`find ~/.telepty/shared -name '*.md' -newermt <entry time>`. Verified on this machine:

```
$ find ~/.telepty/shared -name '*.md' -newermt '-10 minutes'
bfs: error: ... -newermt "-10 minutes"
bfs: error: Invalid timestamp.
```

`find` resolves to `bfs`, which rejects relative `-newermt` arguments; `-newermt` is in any case a
GNU/BSD extension, not POSIX — **a Rule 26 (Cross-OS Abstraction Mandate) and Art.2 violation** in
a command that ships to every user.

**Replacement — marker file + POSIX `-newer`** (verified working under `bfs` on this machine):

```sh
# entry — one 0-byte marker
mkdir -p "$HOME/.aigentry/plan-mode"
: > "$HOME/.aigentry/plan-mode/${TELEPTY_SESSION_ID:-local}.entry"

# turn boundary + exit — sweep, read anything new BEFORE acting
[ -d "$HOME/.telepty/shared" ] && find "$HOME/.telepty/shared" -name '*.md' \
  -newer "$HOME/.aigentry/plan-mode/${TELEPTY_SESSION_ID:-local}.entry" 2>/dev/null

# exit — remove marker (no GC needed: the file that creates it also removes it)
rm -f "$HOME/.aigentry/plan-mode/${TELEPTY_SESSION_ID:-local}.entry"
```

`-newer FILE` is POSIX and universal. The marker is 0 bytes, self-cleaning, and doubles as an
observable "in plan mode" flag for any future probe.

**Honest coverage limit.** The sweep recovers **ref-carrying** injects only (`shared/*.md`).
Inline injects (`telepty inject "<text>"` with no `--ref`) leave no file and are **not**
recoverable this way. This is acceptable because the high-value classes are already ref-carrying by
rule: every dispatch must go through `bin/dispatch.sh --ref` (Rule 32 dispatch-helper), and the
mandatory REPORT shape is `--ref FILE`. The uncovered residue is short inline acks — low value, and
**#760 is what closes it properly**. That is the graceful dependency §1.3 requires: the gate is
useful before #760 and strictly better after it.

### §2.4 Skill SSOT, name, and frontmatter

**SSOT = devkit `skills/`.** Applying the ADR 2026-07-26 §2 tiebreak — *"does this skill invoke
this repo's `bin/` by path?"* — the answer is **NO**, verified step by step: session-type detection
reads an env var; the gate uses harness tools; the sweep uses POSIX `find`; the worker branch sends
a `telepty inject` (telepty's public CLI). The HITL Gate is opened by the **orchestrator** on
receipt of the HOLD (ADR 2026-07-26-hitl-gate-primitive producer (c)) — already its job, not the
skill's. No `bin/` path invocation ⇒ **devkit**.

**Name: `ambiguity-gate`.** Kebab-case; no collision with any of the 23 installed skills; parallel
to the established `deliberation-gate` (a `-gate` skill = an automatic checkpoint inserted into a
workflow); and deliberately *not* `plan-*`, which would collide with the oh-my-claudecode `plan`
command family (§2.6).

Cost, stated honestly: "Gate" now names three things — the spawn-capability Gate (`src/gate/`,
ADR-MF #15), the **HITL Gate** (`state/hitl/`), and the **Ambiguity Gate**. The HITL ADR's M5
already owes `CONTEXT.md` a disambiguation entry; this ADR extends that obligation to three
(§11 coder B).

**Frontmatter** (per devkit census — `deliberation-gate` establishes `prerequisites` + `fallback`):

```yaml
---
name: ambiguity-gate
description: |
  Blocks action on an ambiguous task until the interpretation is chosen. Interactive sessions
  enter plan mode with the competing interpretations written out; dispatched workers send a HOLD
  inject instead (plan-approval UI is on a screen nobody watches). Fires on task-shaped requests
  only. Use when a request has ≥2 plausible readings of target/scope/deliverable/success-criteria,
  or implies an unbounded destructive operation.
  Triggers: "ambiguous", "not sure what you mean", "plan mode", "which one", "모호", "애매",
  "플랜 모드", "뭘 말하는지", "범위가", "어디까지".
version: 0.1.0
prerequisites:
  tool: [EnterPlanMode]
fallback: written-plan-hold
---
```

`prerequisites.tool` rather than `harness: [claude-code]`: the real dependency is the tool, it is
**observable** (a session can check whether it has it), and it degrades correctly if another CLI
ever ships an equivalent. A brand claim would not.

**§17.4 written fallback — REQUIRED, since plan mode is Claude-Code-only.** `fallback:
written-plan-hold`: emit the N interpretations as a numbered block, name the recommended one, and
**stop — no state-mutating tool call until the user answers.** Same contract (no action before
approval), weaker enforcement (discipline, not a harness modal). Stated as weaker, not equivalent.

Two facts shrink the §17.4 exposure, and one keeps it real:

1. The **worker branch needs no plan mode at all** — HOLD inject is already CLI-agnostic. That is
   the majority of sessions in this ecosystem.
2. The orchestrator — the only routinely interactive session here — is Claude.
3. But devkit ships to the public, where an interactive codex/gemini session is ordinary. And
   today devkit's installer writes `~/.claude/skills/` only; codex reads `$CODEX_HOME/skills/`
   (ADR 2026-07-26 §2 per-CLI reach table, §9 Q5). **For those sessions the skill is not installed
   at all** — which is precisely why Rule 37 in `docs/rules.md` is the normative text and the skill
   is only its operational aid. The rule must be legible and complete without the skill.

### §2.5 Rule 37 — normative text (draft for coder B)

Next free number verified: `docs/rules.md` currently ends at Rule 36 (line 583).

```markdown
## Rule 37. 모호한 태스크는 게이트를 통과해야 한다 (HARD RULE)

**task-shaped 요청에 모호함이 남아 있으면, 해석이 확정되기 전에는 상태를 바꾸는 행동을 시작하지 않는다.**
발단: 2026-07-26. 사용자 지시: "태스크에 모호함이 있을때는 항상 무조건 plan mode로 동작하도록 해줘."

**Why:** 응답원칙 §4(다중 해석 surface)와 Rule 30의 "Spec 모호 시 multi-interpretation surface" 행은
*무엇을 할지*만 규정하고 *행동을 막지*는 않았다. 같은 턴에 N개 해석을 제시하고 그중 하나로 그냥
진행하는 것이 문법적으로 허용됐다. Rule 37은 그 문장을 **게이트**로 승격한다.

#### Mandatory
1. **읽어서 풀 수 있으면 게이트 아님** — grep/파일읽기 ~3회로 지시 대상이 확정되면 모호하지 않다.
   읽기가 먼저다.
2. **두 개를 쓸 수 있을 때만 발동** — 경쟁하는 해석 ≥2개를 그대로 적어낼 수 있어야 신호가 선다.
   의심만으로는 발동하지 않는다. 반대로 두 개를 적었으면 조용히 하나를 고르는 것은 금지다.
3. **신호** — 대상 / 범위 / 산출물 / 성공기준 중 하나라도 ≥2해석이면, 또는 범위 없는 파괴적 작업,
   또는 대상 없는 모호 동사, 또는 기존 규칙·ADR과의 충돌.
4. **분기는 화면을 보는 사람이 있느냐로 정한다** — interactive 세션은 plan mode 진입(해석을 plan §1에
   기재, 승인 전 상태 변경 금지). dispatched worker(`AIGENTRY_WORKER_SESSION=1`)는 **plan mode 진입
   금지** — 같은 내용을 HOLD inject로 오케스트레이터에 올린다(승인 UI를 아무도 보지 않으므로).
5. **plan mode 중 컨텍스트 회수 의무** — 진입 시 마커, 턴 경계와 실행 직전에
   `~/.telepty/shared` 신착 스윕. 스윕 없이 승인된 plan을 실행하지 않는다 (#743).
6. **비-task 대화는 대상 아님** — 1라인 ack, 상태 질의, 이미 로드된 컨텍스트로 답하는 질문,
   톤/모드 지시.

#### 예외
- 사용자가 모호함을 인지한 상태로 명시적으로 진행을 지시한 경우 ("그냥 해", "네 판단대로") —
  선택한 해석을 **1줄로 명시**하고 진행한다. 침묵한 채 고르는 것만이 위반이다.
- Rule 30 자율 처리 영역(운영 이슈)은 그대로 자율 — 이 규칙은 운영 자율성을 축소하지 않는다.

#### Cross-references
- 응답원칙 §4: *무엇을* 하는지. Rule 37은 *언제 멈추는지*. 절차는 plan mode 안으로 흡수.
- Rule 30: "Spec 모호 시 multi-interpretation surface" 행의 **메커니즘**이 Rule 37이다.
- Rule 24 (SPEC FIRST): Rule 37은 그 앞단 — 스펙을 쓰기 전에 *무엇의* 스펙인지 확정한다.
- SAWP / HOLD + HITL Gate: worker 분기의 실행 경로 (`docs/adr/2026-07-26-hitl-gate-primitive.md`).
- 스킬: `ambiguity-gate` (devkit `skills/`). 스킬 부재 시에도 이 규칙은 그대로 구속력을 갖는다.
```

### §2.6 Trigger-collision routing table

`ambiguity-gate` fires automatically on **inputs**. Four neighbours could misfire against it.
Following the `diagnose` skill's "## Where this skill fits" convention, the skill body carries this
table verbatim:

| Situation | Route to | Boundary |
|---|---|---|
| The request has ≥2 plausible readings — we do not know **what the user wants** | **`ambiguity-gate`** (this skill) | Request-space multiplicity. **Only the user can resolve it.** |
| The goal is known; **2+ equally valid approaches** to reach it | `auto-multi-llm-review` | Solution-space multiplicity. An LLM panel *can* resolve it. **If both fire, ambiguity-gate goes first** — you cannot deliberate approaches to an unknown target. Deliberation may then run inside the plan or after approval. |
| An artifact already exists (design doc, review feedback, dead-ended debug) and needs multi-AI verification | `deliberation-gate` | Fires on **outputs**; this gate fires on **inputs**. Sequential, never competing. |
| A plan exists and must be stress-tested into a written ADR (Rule 24 SPEC FIRST) | `grill-with-adr` | **Downstream exit**, not a competitor: gate → approved plan → if the decision is ADR-weight (scope ≥ cross-project, or one-way) → grill. Also: grill is user-invoked; this gate is automatic. |
| oh-my-claudecode "Broad Request Detection" → `explore` → `architect` → `plan` | Compatible — runs **inside** plan mode | OMC owns an optional *interview method*; Rule 37 owns the *gate* (no action before approval). Art.17.2: OMC must never be required — the gate uses native plan mode and works with OMC absent. Conflict exists **only** if an OMC flow acts before approval; then Rule 37 wins. |
| Design exploration before building something new | `superpowers:brainstorming` | Brainstorming explores a *chosen* direction; the gate decides *which* direction is being asked for. Brainstorm inside plan mode, or after approval. |
| "Why does this break?" rather than "what should we build?" | `diagnose` | Wrong axis entirely — no ambiguity gate on a reproduction. |

## §3 Alternatives Considered

### §3.1 Alternative A — Rule + checklist only, no skill

- **Description**: `docs/rules.md` Rule 37 + AGENTS.md row. No skill, no devkit change.
- **Pros**: zero distribution cost; reaches every CLI equally; nothing to install or version.
- **Cons**: the user explicitly asked for a skill ("이것도 스킬로 만들어줘"). `docs/rules.md` lives
  in the orchestrator repo and does **not** reach worker sessions — they boot with composed role
  instructions, not the full rules file. And a rule cannot carry the operational steps (detection,
  sweep commands, routing table).
- **탈락 이유**: fails the directive and has no reach into the sessions that most need the worker
  branch. Retained as the *floor*: Rule 37 is written to be binding with the skill absent (§2.4).

### §3.2 Alternative B — Hook-enforced (UserPromptSubmit hook forces plan mode)

- **Description**: a Claude Code hook inspects each prompt and forces plan mode on a match.
- **Pros**: genuine hard enforcement — the agent cannot rationalize past it. Directly answers
  "무조건".
- **Cons**: (i) a hook cannot judge ambiguity without an LLM call; a regex hook fires on every
  "fix" and the resolve-by-reading brake becomes unimplementable — the exact over-trigger failure
  §2.1 is built to avoid; (ii) hooks are Claude-Code-specific settings — no codex/gemini path,
  Art.17.3 violation with no fallback; (iii) it cannot be overridden when the user says "그냥 해",
  making the §2.5 exception unexpressible.
- **탈락 이유**: buys enforcement by making the predicate stupid. **Recorded as the escalation
  path**: if M1 (§8) shows the gate is being skipped on genuinely ambiguous tasks, a warn-mode
  hook is the next step — not the first one.

### §3.3 Alternative C — Plan mode for **every** task (drop the ambiguity test)

- **Description**: the literal reading (i) of "무조건". Every task-shaped request enters plan mode.
- **Pros**: perfectly deterministic; zero judgment; trivially auditable.
- **Cons**: turns a one-line change into a two-round-trip ceremony. Users approve without reading
  within days, and the gate stops carrying information — worse than no gate, because it *looks*
  like one. Contradicts the confirmed 발동 경계 row and the directive's own "모호함이 있을때".
- **탈락 이유**: §1.1 interpretive ruling. Recorded because it is the reading a careless
  implementer will drift toward, and M1's over-trigger threshold is calibrated against it.

### §3.4 Alternative D — Route interactive sessions through the HITL Gate too

- **Description**: one uniform mechanism. Ambiguity ⇒ `hitl.sh open --kind decision` for everyone.
- **Pros**: a single code path; every ambiguity becomes a durable, resumable, auditable record.
- **Cons**: in an interactive session the human **is** watching. A gate file + notify inject +
  `hitl.sh approve <id>` round trip is strictly worse than a native modal the user answers in one
  keystroke — and it would put a filesystem record on every conversational disambiguation.
- **탈락 이유**: it inverts the thesis. Mechanism follows *watched vs unwatched*; forcing the
  unwatched mechanism onto a watched surface pays the durability cost where durability is free.
  Its rejection is what makes the dual branch principled rather than arbitrary.

### §3.5 Chosen — Dual-branch gate, split by watched surface

- **Description**: §2. One skill, one predicate, two branches; devkit SSOT; Rule 37 normative.
- **선택 근거**: it is the only option that satisfies the directive (a skill, unconditional on
  ambiguity), respects the confirmed role-dual decision, adds zero dependencies, reuses three
  existing mechanisms (plan mode, HOLD/HITL, `AIGENTRY_WORKER_SESSION`), and degrades to written
  prose under Art.17.4 rather than breaking. §5 scores it.

## §4 Constitution Check

### Q1: AI 기술 격차 해소에 복무하는가?

**PASS.** The costliest failure for a non-expert is not a wrong answer — it is a confident agent
that silently picked reading #2 and burned a wave of sessions on it, invisibly. This gate converts
"the agent guessed" into "the user chose", using a harness primitive that needs no install and no
expertise to operate (answer a modal). An expert can audit a guess; a beginner cannot. This is
squarely Preamble territory.

### Q2: 이 기능은 어느 컴포넌트의 역할인가? (제3조)

**PASS.** Four owners, no bleed: **detection + gating** = every session's own responsibility (the
skill); **distribution** = devkit (`skills/` → `~/.claude/skills/`); **normativity** = orchestrator
repo (`docs/rules.md`, `AGENTS.md`); **modal-inject safety** = telepty (#760). The skill does not
actuate HITL gates — `bin/hitl.sh` stays the orchestrator's, invoked by the orchestrator on receipt
of a HOLD, exactly as ADR 2026-07-26 producer (c) already specifies. telepty learns nothing about
plan mode.

### Q3: 이 프레임워크/라이브러리가 정말 필요한가? (제1조 경량, 제17조)

**PASS.** Zero new dependencies: native `EnterPlanMode`/`ExitPlanMode`, POSIX `find`, one 0-byte
marker file, one env-var read, one markdown file. No script, no daemon, no state directory, no
schema. The oh-my-claudecode broadness heuristic is **cited, not depended on** (Art.17.2), and its
`plan` interview family is explicitly optional (§2.6).
**Deletion test**: remove `ambiguity-gate` → Rule 37 remains normative and behavior degrades to
today's 응답원칙 §4 prose. Nothing else breaks. That is the correct blast radius for a skill.

### Q4: 모든 크로스 환경에서 동작하는가? (제2조, 제14조)

**PASS — with a stated limitation.** Plan mode is Claude-Code-only. Three mitigations: (i) the
worker branch — most sessions — needs no plan mode; HOLD inject is CLI-agnostic; (ii) §17.4
`written-plan-hold` fallback for interactive codex/gemini, declared in frontmatter; (iii) the sweep
is POSIX, and this ADR **fixes** a non-POSIX command the brief proposed (`-newermt`, §2.3) that
would have shipped a Rule 26 violation to every user.
Residual, carried honestly: codex sessions do not receive devkit skills at all today (ADR
2026-07-26 §9 Q5) — for them Rule 37's text is the reaching mechanism, not the skill. Not a FAIL:
the fallback exists, is written, and no core function is blocked.

### Q5: 사용자에게 "어떻게"를 강요하지 않는가?

**PASS — with the adoption risk named.** There is no command to learn: the gate is automatic and
the user's interface is a modal they answer. But it **does** impose a round trip, and an
over-triggering gate is a tax the user will route around. Three dampers, in order of importance:
the **resolve-by-reading brake**, the **task-shaped filter**, and the **write-two rule**. M1 (§8)
measures over-triggering with an explicit rollback threshold. Naming this risk is not a formality
— it is the most likely way this decision fails.

**Verdict: PASS.** No constitutional conflict. No orchestrator waiver required. Also unaffected and
Pass: 제4조 (architect designs, coders implement — this ADR creates no code), 제9조 (deleting the
skill leaves every component working), 제13조, 제15조 (§11 registers the new domain terms).

## §5 Trade-off Matrix

| 기준 | Weight | A rule-only | B hook | C always-plan | D uniform HITL | **Chosen** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 구현 복잡도 (낮을수록 高) | 2 | 5 | 2 | 4 | 3 | 4 |
| 리스크 (오발동 / 사용자 이탈) | 3 | 4 | 1 | 1 | 3 | 4 |
| 헌법 정합 (Art.1/17) | 5 | 4 | 1 | 3 | 3 | 5 |
| 크로스 플랫폼 호환 | 3 | 5 | 1 | 3 | 5 | 4 |
| 지시 충족도 (스킬 + 무조건) | 4 | 1 | 4 | 3 | 2 | 5 |
| 가역성 | 2 | 5 | 3 | 4 | 2 | 5 |
| **Total (weighted)** | | **65** | **31** | **48** | **51** | **80** |

Chosen loses points only on cross-platform (plan mode is Claude-only, §4 Q4) and implementation
complexity (a two-branch predicate is more than a rule sentence). It wins where it must: Art.1/17
compliance, over-trigger risk, and actually doing what was asked.

## §6 Backward Compatibility

**Additive. No migration.** Nothing that is autonomous today becomes manual; Rule 30's autonomy
table is untouched — no operational issue becomes a plan-mode question.

| Existing consumer | Change needed |
|---|---|
| `AGENTS.md` 응답원칙 §4 (다중 해석 surface) | **None — text unchanged.** §4 still says what to do; Rule 37 upgrades the *container*: the N interpretations are now presented inside a plan awaiting approval rather than as free prose in an acting turn. The procedure is absorbed as a step inside plan mode, not rewritten. |
| `docs/rules.md` Rule 30 "Spec 모호 시 multi-interpretation surface" row | **None — row stays verbatim.** Rule 37 supplies its missing mechanism. One cross-reference line added under Rule 37, not inside Rule 30. |
| `docs/rules.md` Rule 30 자율 처리 영역 table | **None. Explicit anti-regression statement**: sandbox prompts, trust modals, blank panels, stuck sessions, stale cleanup, AUTO_REPORT stay autonomous. Rule 37 fires on **task-shaped user requests**, never on operational conditions. |
| `.agents/skills/orchestrate-turn/SKILL.md` Step 1 / 1-1 | **One line.** Step 1 gains: run the ambiguity test → if it fires, gate **before** 1-1 breakdown. `AskUserQuestion` remains the asking mechanism *inside* plan mode. Step-1 wording ("surface N interpretations and ask") already describes the content; only the gate is new. Repo-coupled skill ⇒ orchestrator repo owns this edit (tiebreak: it names `bin/` scripts throughout). |
| `docs/sawp.md` "Never idle" + HOLD | **None.** A HOLD is not idling — the HITL ADR already settled this by expressing waiting as registry status `awaiting_user`, which excludes the session from AUTO_REPORT, re-dispatch, and GC. Rule 37's worker branch reuses that path unchanged. |
| devkit `skills/deliberation-executor` "입력이 불완전하면 즉시 확인" | **None (Rule 29 surgical).** The line is weaker but not contradictory; it stays. It gains a pointer only if that skill is edited for another reason. No dispatch is spent on it. |
| devkit `package.json` `files[]` | One entry: `"skills/ambiguity-gate/**"` — exact shape required by `lib/skills-drift.js:18` (`/^skills\/([^/*]+)\/\*\*$/`), or the drift guard silently ignores the skill. |
| Existing devkit installs | Gain one skill on next `install.sh --force`. No removals, no renames. |

## §7 Consequences

### §7.1 Positive

- The "never silently pick one" principle becomes **enforceable** rather than aspirational — it
  moves from a sentence about output to a gate on action.
- A Claude Code primitive that this ecosystem has never referenced (0 grep hits) starts earning
  its keep.
- The detection artifact **is** the plan's first section — no duplicated effort, and the plan
  cannot be vaguer than the detection that produced it.
- The worker branch closes a real hole: a worker's ambiguity currently has no structured channel
  beyond convention. It now lands in the same resumable HITL Gate as every other human decision.
- #743's loss class gets a mitigation that ships **now**, independent of #760.

### §7.2 Costs / negative

- Every ambiguous task costs one approval round trip. Over-triggering is the failure mode (§4 Q5).
- A third meaning for "Gate" in the domain language (§2.4) — `CONTEXT.md` must disambiguate three.
- Cross-repo change: devkit `files[]` edit + version bump to reach anyone (ADR 2026-07-26 §7).
- Interactive codex/gemini sessions get the weaker written fallback, and today do not receive the
  skill at all.
- Rule 37 makes `docs/rules.md` longer — Rule 3 (MD 크기 관리) pressure, accepted: the rule is
  load-bearing and 크기 제한 explicitly yields to 컨텍스트 유실 금지.

### §7.3 Unknown risks

- Whether the write-two rule genuinely produces inter-reader agreement is **unmeasured**. The
  fixture set (§11 coder A) exists to find out, and M2 is its metric.
- Whether ≥1 signal is the right threshold, or whether A1–A4 should require ≥2 (§9 Q1).
- Whether an agent reliably distinguishes "residual after reading" from "resolvable by reading"
  under time pressure — the brake is a judgment, and judgments drift.

### §7.4 Dependent-component failure scenarios

| Failure | Behaviour |
|---|---|
| #760 never lands | Gate still works; Track 2 sweep recovers ref-carrying injects. Residue = inline acks. Degradation, not breakage — the graceful dependency §1.3 requires. |
| `~/.telepty/shared` absent (fresh machine, telepty not installed) | `[ -d ]` guard ⇒ sweep is a no-op. Gate unaffected. |
| `AIGENTRY_WORKER_SESSION` unset on a real worker (env regression) | Worker enters plan mode on an unwatched screen → stall → caught by `dispatch-tracker.sh check` within 30 min (classify → AUTO_REPORT / re-dispatch). Detectable, already instrumented, and the less harmful direction of the asymmetry (§2.2). |
| Env var leaks into the orchestrator | Orchestrator sends a HOLD inject to itself instead of gating. Loud, immediate, and visible in its own conversation — self-diagnosing. |
| Skill absent (not installed / codex session) | Rule 37 remains binding; behavior degrades to `written-plan-hold`. This is why the rule is written to be complete standalone (§2.4). |
| oh-my-claudecode absent | No effect — native plan mode, Art.17.2 honoured by construction. |
| Marker file orphaned (session killed mid-plan) | 0-byte file in `~/.aigentry/plan-mode/`. Next entry truncates it (`: >`). No GC needed. |
| User overrides ("그냥 해") | §2.5 exception: name the chosen interpretation in one line, proceed. Silence is the only violation. |

## §8 Verification Plan

| # | Metric | Measurement | Success threshold | Rollback trigger |
|:-:|---|---|---|---|
| **M1** | **Over-trigger rate** | Over 2 weeks of orchestrator turns: gate firings ÷ task-shaped requests | ≤ 30%, and ≥ 80% of firings produce a user answer that *differs* from the agent's recommendation **or** materially narrows scope | > 50% firing, or > 40% of firings rubber-stamped ⇒ raise A1–A4 to ≥2 signals (§9 Q1) |
| **M2** | **Inter-reader agreement** | 10-case fixture set (5 fire / 5 don't), run against two independent readers (fresh Claude session + codex) | ≥ 8/10 agreement on the verdict | < 7/10 ⇒ the test is not decidable; rewrite the firing tests before shipping the rule |
| **M3** | **Worker branch correctness** | Count of dispatched workers observed in plan mode | **0** | any occurrence ⇒ detection bug; check `AIGENTRY_WORKER_SESSION` propagation |
| **M4** | **Context recovery** | Injects landing in `~/.telepty/shared` during a plan-mode window that are read before the plan executes | 100% of ref-carrying injects | any missed ref ⇒ sweep not wired at the exit point |
| **M5** | **Autonomy non-regression** | Rule 30 operational escalations to the user (sandbox prompt / stuck session / blank panel) | **0** — unchanged from today | any increase ⇒ Rule 37 is firing on operational conditions; tighten Gate A |
| **M6** | **Distribution** | `aigentry doctor --skills` (ADR 2026-07-26 step 7) after `npm i -g` + install on a second machine | `ambiguity-gate` present, digest matches devkit | absent ⇒ `files[]` entry shape wrong (`lib/skills-drift.js:18` regex) |

M2 is the gate on shipping Rule 37 as HARD: if two readers cannot agree on the fixtures, the rule
is not enforceable and must not be written as one.

## §9 Open Questions

- **Q1** — Threshold. Is ≥1 signal correct, or should A1–A4 require ≥2 (keeping A5/A7 at ≥1)?
  ≥1 is the faithful reading of "무조건"; M1 decides empirically. Answer before `status: accepted`
  is not required — the rollback path is defined.
- **Q2** — Does the sweep need to cover an inline-inject store as well as `~/.telepty/shared`?
  Depends on telepty internals and may be moot after #760. Needs a telepty-side answer; carried,
  not guessed.
- **Q3** — codex/gemini skill reach. Inherited verbatim from ADR 2026-07-26 §9 Q5; not re-opened
  here.
- **Q4** — Does a long interactive plan-mode window interact badly with dispatch tracking? Analysis
  says no: the orchestrator is not in `state/dispatch/active.json`, so the 30-minute AUTO_REPORT
  window does not apply to it. Its *workers* keep running and their REPORTs are exactly what the
  Track 2 sweep recovers. Stated for the record; no action.
- **Q5** — Should the gate log firings for M1, and if so where? A JSONL under
  `~/.aigentry/telemetry/` would match the spawn-telemetry precedent, but it is new state for a
  skill that otherwise has none. Recommendation: **manual count for the first two weeks**; add
  telemetry only if M1 proves hard to measure by hand. Art.1.

## §10 Related

- **Related ADRs**: `2026-07-26-hitl-gate-primitive.md` (worker branch destination);
  `2026-07-26-skill-ownership-routing.md` (§2 tiebreak applied in §2.4; §17.4 fallback obligation);
  `2026-06-06-orchestration-sequence.md` (orchestrate-turn step 1 insertion point);
  `2026-05-12-cwd-role-decoupling-immutable-session-contract.md` (role sandbox + worker env).
- **Related tasks**: #759 (this work), #760 (Track 1, `c760m`), #743 (loss evidence, P1 pending),
  #737 (mechanism precedent, done), #740 (HITL Gate).
- **Rules touched**: new Rule 37; cross-references from Rule 24, Rule 29, Rule 30.
- **Constitution**: Art.1 경량, Art.2 크로스, Art.3 컴포넌트 역할, Art.9 독립, Art.17 무의존 (특히
  17.2 / 17.4).

## §11 Rule 4-A — execution mode and implementation plan

**Mode = D (Dispatch).** Selector trace (phase6-conclusion §4.2.2, order B1→B6): B1 no
(Claude-only chain supported) → B2 no (`session_count ≥ 1`; the a759m chain is accumulated) → B3 no
(not `explicit_reuse`) → B4 no (workload is not `default`) → **B5 `workload = external_dispatch`
→ D**. C6 honoured: D carries Layer-1 co-equal status but **no cross-CLI verified claim**.

**Parallel breakdown (Rule 36 / Rule 9).** Two coders, different repos, zero shared files — a
genuine parallel wave, no worktree isolation needed:

| Wave | Session | Repo | Files | Deliverable |
|---|---|---|---|---|
| **W1a** | coder A | `aigentry-devkit` | `skills/ambiguity-gate/SKILL.md` (new)<br>`skills/ambiguity-gate/tests/*.md` (new)<br>`package.json` (`files[]` += `"skills/ambiguity-gate/**"`) | The skill: §2.1 test, §2.2 branch + detection, §2.3 sweep, §2.4 frontmatter, §2.6 routing table. Plus the M2 fixture set — 10 cases (5 fire / 5 don't) in the existing devkit RED/GREEN scenario shape (`templates/skills/propose-next-task/tests/*.md`). |
| **W1b** | coder B | `aigentry-orchestrator` | `docs/rules.md` (Rule 37)<br>`AGENTS.md` (one checklist row)<br>`.agents/skills/orchestrate-turn/SKILL.md` (Step 1, one line)<br>`CONTEXT.md` (glossary) | Rule 37 per §2.5 draft; checklist row in the Rule 36 codify pattern; step-1 gate line; `CONTEXT.md` entries for **Ambiguity Gate** + a three-way "Gate" disambiguation (spawn Gate / HITL Gate / Ambiguity Gate) — absorbing the HITL ADR's outstanding M5 obligation. |

**W1a ∥ W1b.** Different repos, no shared file, no data dependency.

**Within W1b, sequential — recorded reason (b), intrinsic dependency:** the AGENTS.md row and the
`CONTEXT.md` entry both quote Rule 37's text, so the rule must be written first or they drift.
Splitting four coupled markdown files across worktree-isolated sessions to satisfy the letter of
Rule 36 would cost more than it buys and would break that invariant — Rule 36 exception (b) applies
and is recorded here.

**Task registration (Rule 34):** each wave gets its own `state/task-queue.json` entry before
dispatch; `bin/dispatch.sh --task <id>` enforces it.

**Ordering constraint:** M2 (§8) runs on W1a's fixtures **before** Rule 37 lands as HARD in
`docs/rules.md`. If two readers cannot agree ≥8/10, the firing tests are rewritten first. Coder B
may write Rule 37 in parallel but the HARD designation waits on M2.

**Not in scope for either coder** (explicit, to prevent scope creep):
- Track 1 (#760) — separate session `c760m`, telepty repo. Referenced only.
- Any change to `bin/hitl.sh`, `bin/policy.py`, or the reconciler. The gate produces a HOLD; the
  orchestrator's existing HOLD handling opens the HITL Gate.
- Any edit to `deliberation-executor`, Rule 30's tables, or 응답원칙 §4 (§6 — all unchanged).
