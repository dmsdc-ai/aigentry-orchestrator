---
type: adr
status: accepted
revision: r4
accepted_at: 2026-05-06
acceptance_basis: "User signoff (orchestrator session, 2026-05-06) after T2 reviewer threshold met: spec-document-reviewer iter 2 PASS + codex (cross-LLM) ACCEPT_WITH_CONDITIONS resolved through r3 (6 conditions + 2 gates + 2 risks) + r4 (1 text-only minor patch). 3 MAJOR factual corrections via cross-LLM (7/7 parity → 6/7+inject alias; arbitrary keysym → 7 keys/13 spellings allowlist; aterm UDS SendKey routing added). All 7 constitutional articles align."
r4_basis: "codex r3 focused review (`~/projects/aigentry-architect/docs/reports/2026-05-06-aterm-adr-r3-focused-review.md`) ACCEPT_WITH_CONDITIONS — C2 text-only inconsistency: 'arbitrary keysym' (§4.3 #56) and '9 keysyms' (§6.2 Phase 2 invariant + §6.3 sub-PR table) corrected to literal allowlist (7 distinct keys / 13 spellings per `aterm-core/src/app.rs:992-1008`). Text-only, no design change."
date: 2026-05-06
author: aigentry-architect-aterm-adr
scope: aterm + telepty boundary
decision_type: two-way (cleanup phase reversible, feature phase reversible-with-care)
tier: T2
trigger: "Adversarial grill (2026-05-06) on user request '세션 컨트롤 똑같이 도입'"
related:
  - "~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_philosophy.md"
  - "~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_v3_only.md"
  - "~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_session_priority.md"
  - "~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_physical_terminal.md"
  - "~/projects/aigentry-aterm/aterm-context.md"
  - "~/projects/aigentry-orchestrator/docs/rules.md (Rule 29)"
  - "~/projects/aigentry-orchestrator/docs/reports/2026-05-05-aterm-cross-llm-synthesis.md"
  - "~/projects/aigentry-aterm/docs/reports/2026-05-06-aterm-session-control-architecture.md"
related_tasks: [355, 356, 53, 363, 56, 57]
unblocks:
  - "aterm session control parity with cmux (orchestrator-daily 7 verbs)"
  - "aterm self-session telepty bus publish (bidirectional mesh)"
  - "Phase 2 implementation"
tags: [aterm, telepty, session-control, role-separation, opt-3-prime, cleanup-then-feature]
supersedes: []
reviewers_recommended: [spec-document-reviewer, codex (cross-LLM)]
revision_history:
  - r1: "2026-05-06 — Initial draft from grill outcomes"
  - r2: "2026-05-06 — spec-document-reviewer iter 1: drop bus-byte streaming over-scope in §6.2; replace §3.4.4 synthesized arrows with verbatim section headers + summary framing; ground related_tasks [53, 56, 57] in §4.3; reviewers — codex required (T2 strict)"
  - r3: "2026-05-06 — codex (cross-LLM) ACCEPT_WITH_CONDITIONS (review report commit `0ab725a`, `~/projects/aigentry-architect/docs/reports/2026-05-06-aterm-adr-codex-review.md`). Resolved 6 conditions + added 2 gates (M1/M2 per codex §7) + 2 risks (R3/R4 per codex §8): C1 aterm CLI 7/7 → 6/7 (inject alias missing, Phase 2 +5LOC); C2 'arbitrary keysym' → allowlisted (enter/return/ctrl-c/d/l/z/tab/esc/escape per `aterm-core/src/app.rs:992-1008` allowlist, accepted as-is — no Phase 2 expansion); C3 telepty sub-PR adds aterm UDS SendKey routing (`daemon.js` writeDataToSession aterm branch — codex §6 Finding C); C4 frozen-ref SHAs (aterm-context.md `62f6cd0a854cb2183563521260c6b20e4f3409b0`, Rule 29 full `d9bf7f575be9ae19b16acf584821d406b29a2d0a`, memory files marked `non-git, frontmatter-only`); C5 Phase 1 cleanup adds root `package-lock.json` (delete) + `scripts/patch-xterm-wk-ime.mjs` (delete, v2 @xterm patch orphaned post-cleanup); C6 telepty sub-PR ownership = orchestrator dispatch + Phase 2 acceptance records telepty commit-SHA + tag (target ≥0.3.6) + graceful degradation against pre-keysym telepty. Effort revised 1.5w → 2-2.5w (telepty sub-PR ~30LOC → ~70-100LOC per codex §9 + lesson F4)."
  - r4: "2026-05-06 — codex r3 focused review (`~/projects/aigentry-architect/docs/reports/2026-05-06-aterm-adr-r3-focused-review.md`) ACCEPT_WITH_CONDITIONS, single C2 text-only inconsistency. 3 minor edits, no design change: §4.3 #56 'arbitrary keysym' → 'allowlisted keysym'; §6.2 Phase 2 invariant '9 keysyms' → '7 distinct keys / 13 spellings'; §6.3 sub-PR table cli.js row '9 keysyms' → '7 distinct keys / 13 spellings'. Numbers trace to `aterm-core/src/app.rs:992-1008` (7 keys: enter, ctrl-c/d/l/z, tab, esc; 13 string spellings). Surgical (Rule 29). No effort/scope/risk impact."
---

# ADR 2026-05-06: Aterm Session Control via opt-3-prime (Cleanup → Activate Internal Model)

## §1 Status, Context, Trigger

- **Status**: **proposed** (r1, 2026-05-06). Architect locks `proposed` per architect AGENTS.md §5.6 INVARIANT; orchestrator flips to `accepted` only on user signoff after spec-document-reviewer PASS + Tier-T2 reviewer threshold.
- **Date**: 2026-05-06.
- **Tier**: **T2** (adr × cross-project × two-way → 2 reviewers + user). Scope crosses two repos (`aigentry-aterm`, `aigentry-telepty`) and consolidates 5 architectural decisions; reviewer threshold = 2 (spec-document-reviewer self-cycle + optional codex cross-LLM).
- **Decision type**: **two-way**. Phase 1 (cleanup) is fully reversible (delete dead code, revert via git). Phase 2 (feature: AttachExternal activation + bidirectional mesh + telepty `send-key` patch) is reversible-with-care — wire-protocol surface additions are additive, but bus-event consumers downstream may bind once shipped.
- **Scope**: aterm ↔ telepty boundary. **No** orchestrator/Rule 4-A surface impact (Rule 4-0 narrow lock unaffected). **No** brain/CMP impact.
- **Trigger**: User request "세션 컨트롤 똑같이 도입" → orchestrator dispatched the `grill-with-adr` skill (cherry-picked 2026-05-05 per `reference_pocock_skills_installed.md`) which ran an adversarial spec interview on 2026-05-06 yielding 5 architectural decisions (§2). All 5 align with pre-existing direction documents (§3.4); this ADR captures — does not extend — the grill outcomes per architect §5.3 INVARIANT and lesson F1.

### §1.1 Inputs synthesized (binding)

| Input | Path | Frozen ref |
|---|---|---|
| Grill outcomes (5 OQ) | dispatch source-of-truth | `~/.telepty/shared/4034cd588d055c721319eb18f9b0451375c92814b9e94dc776671207df1cec77.md` (ingested 2026-05-06; mirrored at `/tmp/aigentry-dispatch/aterm-adr-writeup.md`) |
| aterm philosophy memory | `~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_philosophy.md` | memory frontmatter `name: aterm philosophy - lightweight cross-everything terminal` (non-git source — frontmatter-only ref; verbatim quote at §3.1 captures content as of 2026-05-06) |
| aterm v3-only memory | `feedback_aterm_v3_only.md` | memory frontmatter (non-git source — frontmatter-only ref; verbatim quote at §3.4.1 captures content as of 2026-05-06) |
| aterm > cmux priority memory | `feedback_aterm_session_priority.md` | memory frontmatter (non-git source — frontmatter-only ref; verbatim quote at §3.4.2 captures content as of 2026-05-06) |
| Physical PTY memory | `feedback_physical_terminal.md` | memory frontmatter (non-git source — frontmatter-only ref; verbatim quote at §3.4.3 captures content as of 2026-05-06) |
| aterm internal/external command split | `~/projects/aigentry-aterm/aterm-context.md` §"aterm 세션 통신" | commit `62f6cd0a854cb2183563521260c6b20e4f3409b0` (last-touched aterm-context.md SHA at r3 freeze) |
| Rule 29 surgical edit (HARD RULE) | `~/projects/aigentry-orchestrator/docs/rules.md:349–360` | commit `d9bf7f575be9ae19b16acf584821d406b29a2d0a` (2026-05-05, full SHA per codex C4) |
| Architect deep-analysis (read-only audit) | `~/projects/aigentry-aterm/docs/reports/2026-05-06-aterm-session-control-architecture.md` (537 lines) | **uncommitted** in `aigentry-aterm` working tree at r3 freeze (verified `git status` 2026-05-06); orchestrator MUST commit the report and substitute the resulting SHA before this ADR flips to `accepted` (codex C4 spirit — frozen refs require concrete SHAs, not "HEAD") |
| Cross-LLM synthesis (Phase 1 backlog source) | `~/projects/aigentry-orchestrator/docs/reports/2026-05-05-aterm-cross-llm-synthesis.md` | 2026-05-05 |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 3, 5, 9, 13, 17 | repo |

---

## §2 Decision (HARD-NUMBERED)

### §2.1 Adopt opt-3-prime

Summary (paraphrasing architect deep-analysis §5 Decision, 2026-05-06): aterm v3 is the primary, standalone session-controller. Model B (`aterm-core::PtyManager`) owns PTYs; `bin/aterm.js` is the canonical orchestrator-daily CLI; telepty is **retained as the optional cross-terminal discovery + cross-machine bus, never as the in-aterm PTY owner**. The change is **mostly a cleanup + documentation effort (~2-2.5 person-weeks)** — revised at r3 from r2's 1.5w estimate after codex C3 surfaced that the telepty sub-PR scope is ~70-100 LOC (not 30 LOC) because today's `/submit` force path (`daemon.js:1541-1545` → `terminalLevelSubmit()` at `:630-643`) does not route `SessionAction::SendKey` to aterm UDS sessions and a new dispatch branch is required (per lesson F2/F4: "effort estimates often unchanged after fixes despite scope creep").

opt-3-prime is one of three options surveyed in the architect deep-analysis §3 (opt-1 viewer-only / opt-2 cmux replacement / opt-3-prime activate aterm-internal + cleanup). Opt-1 and opt-2 are rejected in §5; selection rationale lives in §3 (Context — direction-document alignment).

### §2.2 Five OQ resolutions (BINDING — captured from grill 2026-05-06)

| # | OQ | Resolution | Anchor |
|---|---|---|---|
| OQ1 | AttachExternal disposition (delete vs downgrade vs activate) | **α — activate.** Wire `lib.rs:2499`/`lib.rs:2563` Swift host callback through to a real bus-byte / discovery handler; aterm becomes telepty bus consumer + UI viewer for cross-terminal pills | Constitution Article 2 (크로스); aterm-philosophy.md "telepty=크로스레이어" |
| OQ2 | Cross-terminal inject fallback (shell-out vs fail-fast vs mesh) | **(i) 양방향 mesh.** aterm publishes its own session lifecycle to telepty bus; aterm CLI shells out to `telepty inject` when target unknown locally | aterm-philosophy.md "telepty = 모든 크로스 레이어 해결" |
| OQ3 | Headless tracking | **(i) 미지원.** aterm = GUI client; headless PTY ownership belongs to telepty daemon | feedback_physical_terminal.md "Claude Code(AI CLI)는 물리적 터미널(PTY)이 필요" |
| OQ4 | Telepty patch coordination (single-PR vs split) | **(c) 2-Phase split.** Phase 1 cleanup-only PR → Phase 2 feature PR + telepty sub-PR | Rule 29 (HARD RULE, commit `d9bf7f575be9ae19b16acf584821d406b29a2d0a`); aterm v3 phasing precedent (2026-03-29 Phase 1) |
| OQ5 | Aterm `identify` payload shape | **deferred to implementation** (writing-plans phase). API-level detail; not architectural | architect §5.1 INVARIANT — pseudo-code only at ADR layer |

### §2.3 2-Phase split (per OQ4)

Phase 1 and Phase 2 are SHIPPED as separate orchestrator dispatches with separate PRs, separate review cycles, and separate accept gates. Lesson F4 — Phase 1 + Phase 2 belong in **one ADR** (single decision: opt-3-prime), but split at the **PR/dispatch** level for Rule 29 surgical-edit discipline.

| Phase | Surface | Backlog | Effort | Reversibility |
|---|---|---|---|---|
| **Phase 1 — Cleanup only** | aterm repo dead-code + ghost workspace + Tauri/Svelte residue | #355 + #356 (P1 each) | ~3–5 days | fully reversible (git revert) |
| **Phase 2 — Feature** | aterm AttachExternal wire-through + self-session bus publish | new task (TBD on accept) | ~3–5 days | reversible-with-care (additive bus events) |
| **Phase 2 sub-PR** | telepty repo `send-key` allowlisted-keysym patch + **aterm UDS `SendKey` routing branch** in `daemon.js` (~70-100 LOC, 3-4 files — revised from 30 LOC per codex C3 + lesson F4) | new task (telepty repo) | ~2-3 days | additive |

Phase 1 MUST land before Phase 2 starts. Rationale: dead-code removal eliminates grill-grade ambiguity that would otherwise re-surface during Phase 2 review (architect deep-analysis §3 "Common pre-requisite"); shipping Phase 2 features atop ghost-crate / dead-renderer surface would violate Article 1 (경량) by amplifying the already-bloated surface.

---

## §3 Context (Pre-existing Directions + Facts)

### §3.1 aterm philosophy (verbatim, BINDING)

`~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_philosophy.md`:

> aterm의 철학: **모든 멀티크로스 환경에서 동일한 사용자 경험을 제공하는 경량 터미널.**
>
> - **aterm** = 경량 접속 포인트. 어느 머신에서든 aterm으로 접속하면 동일한 경험.
> - **telepty** = 모든 크로스 레이어 해결 (머신/OS/세션/폴더/프로젝트 연결)
> - **brain** = 하나의 컨텍스트로 묶음 (기억, 프로필, 설정 동기화)
> - aterm 자체는 경량. 무거운 기능은 telepty와 brain이 담당.

This is the load-bearing direction document for the entire decision. opt-3-prime preserves "aterm = 경량 접속 포인트" by removing dead code; preserves "telepty = 크로스 레이어" by routing cross-terminal control via telepty bus (OQ2 양방향 mesh); preserves Article 9 (독립) because aterm Model B already runs without telepty (`aterm-core::PtyManager` owns PTYs in-process; `aterm-ipc` UnixSocket carries the CLI surface).

The same memory document records: "*iced를 유지하라고 권장했다가 정당한 비판을 받음. iced는 오버엔지니어링이었고 IME 문제의 근본 원인이 됐다.*" Lesson: framework-laden choices are rejected. opt-1 (viewer-only with new bus wire-protocol) and opt-2 (cmux replacement) repeat that mistake on a different surface; opt-3-prime does not.

### §3.2 Architecture facts (architect deep-analysis 2026-05-06)

| Fact | Verified at | Implication |
|---|---|---|
| Model A (telepty-bus consumer): scaffolding only, **0% runtime PTY-byte stream** | `lib.rs:2499`/`2563` AttachExternal noop; `TeleptyBusClient.swift:263–272` status-only | OQ1 must decide disposition (resolved: α activate per §2.2) |
| Model B (`PtyManager`): **100% runtime** — aterm self-hosting | `aterm-core/src/pty.rs:260–463` spawn + reader; `aterm-ipc/src/server.rs` 252 LOC peer-uid auth | opt-3-prime feasibility confirmed |
| `bin/aterm.js` (242 LOC) covers **6/7 orchestrator-daily verbs** today; `inject` alias missing (per codex C1, verified at `bin/aterm.js:216-226`) | actual commands = `send / send-key / read-screen / list-workspaces\|ls / new-workspace\|new / close-workspace\|close / status`. The 7-verb spec = `list / new / close / inject / send / send-key / read-screen`; mapping: list↔ls✓ new↔new✓ close↔close✓ send✓ send-key✓ read-screen✓ — `inject` ✗ (documented in `aterm-context.md:34` as `aterm inject ghostty 'make build'` but not implemented). `status` is bonus (not on the 7-verb list). | "session control" gap is mostly illusion at the aterm layer; only the `inject` alias (~5 LOC) is genuinely missing. Phase 2 §6.2 closes it. |
| `SessionAction::SendKey { key: String }` schema accepts an arbitrary string, but the dispatcher allowlists **7 distinct keys** (Enter, Ctrl-C, Ctrl-D, Ctrl-L, Ctrl-Z, Tab, Esc) — **13 string spellings** total: `enter / return / ctrl+c / ctrl-c / ctrl+d / ctrl-d / ctrl+l / ctrl-l / ctrl+z / ctrl-z / tab / esc / escape` (codex C2; lowercased compare via `to_ascii_lowercase()`) | schema: `aterm-session/src/action.rs:55-58`; dispatcher: `aterm-core/src/app.rs:992-1008` (`is_supported_send_key`); Swift map: `macos/Sources/AppDelegate.swift:2126-2145` (`keyPayload(for:)` matches the same allowlist) | aterm is **broader than telepty** (telepty's `cli.js:1831–1860` is Enter-only) but **not arbitrary**. Phase 2 accepts the existing allowlist as-is (no expansion); §6.2 invariants below explicitly lock this scope. Real gaps: (a) telepty `/submit` force path (`daemon.js:1541-1545` → `terminalLevelSubmit()`) only routes Enter via kitty/cmux/PTY, no aterm UDS branch — codex C3; (b) telepty CLI enter-only guard. |
| ~3621 LOC dead `renderer*.rs` gated by undefined `wgpu` feature | `aterm-core/src/{renderer,renderer_atlas,renderer_glyph}.rs` + `lib.rs:51–67` `pub mod` decls + `#[cfg(feature="wgpu")]` 30+ guards | Phase 1 surgical removal target |
| Ghost root crate `[[bin]] aterm-v3 → src-v3/main.rs` does not exist | `Cargo.toml:10-12`; target dir absent | Phase 1 surgical removal target |
| Tauri/Svelte stack residue (~5GB archived/) | `archived/src-v3-future/`, `archived/src-tauri-v1/`, root `package.json`, `src/`, `vite.config.js`, `index.html` | Phase 1 surgical removal target |

### §3.3 cmux ↔ aterm command parity (6/7 today; 7/7 after Phase 2 `inject` alias)

The user-perceived gap "세션 컨트롤 똑같이 도입" is partially illusion at the aterm layer (per §3.2 row 3). The architect deep-analysis §2.1 three-way parity matrix records: **6 of 7** orchestrator-daily verbs (`list / new / close / send / send-key / read-screen`) are already covered by `bin/aterm.js` over `aterm-ipc` UnixSocket; the seventh (`inject`) is **documented in `aterm-context.md:34` but not implemented in `bin/aterm.js:216-226`** (codex C1). The real gap is two-fold: (a) the missing `inject` alias on aterm (Phase 2 §6.2, ~5 LOC), and (b) telepty's `send-key` Enter-only guard (telepty `cli.js:1831–1860` + `daemon.js:1541-1545` force path → `terminalLevelSubmit()` only sends `\r` via kitty/cmux/PTY, no aterm UDS `SendKey` branch — codex C3) which Phase 2 sub-PR addresses.

Aliases still missing on `bin/aterm.js` (`inject`, rename, focus, restart, identify, wait-until, subscribe) are typed `SessionAction`s that exist in `action.rs:5–80`; only the Node-CLI alias surface is missing. Adding them is alias work (~5×8–15 LOC for non-inject, ~5 LOC for `inject` reusing `cmdSend`'s payload), not new dispatcher functionality.

### §3.4 Existing direction documents (verbatim, BINDING)

The following pre-existing directions BIND this ADR (lesson F3 — verbatim quote, no paraphrase):

#### §3.4.1 v3-only mandate

`~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_v3_only.md`:

> aterm의 모든 기능 추가/버그 수정은 반드시 src-v3(순수 Rust 네이티브)에서 진행한다. src/(Tauri+Svelte) v2는 더 이상 사용하지 않음.

Implication: Phase 1 cleanup of `src/`, root `package.json`, `vite.config.js`, `index.html`, `archived/src-tauri-v1/` is **already-mandated cleanup**, not a new architectural choice. opt-3-prime ratifies the mandate at the file level.

#### §3.4.2 aterm > cmux dogfooding priority

`~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_aterm_session_priority.md`:

> 세션에 태스크를 위임할 때 aterm에서 실행 중인 세션을 cmux 세션보다 우선한다.
>
> **Why:** aterm이 에코시스템의 '터(플랫폼)'이므로 aterm을 dogfooding해야 제품 품질이 올라감. cmux에만 세션을 띄우면 aterm을 실사용하지 않는 것.

Implication: opt-3-prime aligns by making aterm the standalone session-controller (zero-friction dogfood). opt-1 (viewer-only, telepty-dependent) and opt-2 (cmux-replace) both add friction — opt-1 forces telepty as PTY owner (degrades aterm dogfood); opt-2 absorbs cmux (months of work distract from aterm dogfood). opt-3-prime is the only option that compounds dogfood velocity.

#### §3.4.3 Physical PTY constraint (drives OQ3 headless decision)

`~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_physical_terminal.md`:

> Claude Code(AI CLI)는 물리적 터미널(PTY)이 필요하다. `telepty spawn`으로 백그라운드 세션을 만들 수 없다.

Implication: headless tracking inside aterm-core (OQ3) would re-introduce a problem already solved by the telepty daemon. Resolution **(i) 미지원** preserves role separation: aterm = GUI client; telepty = daemon owning headless lifecycle. Article 3 (역할) preservation.

#### §3.4.4 Internal vs External command split

`~/projects/aigentry-aterm/aterm-context.md` §"aterm 세션 통신" — section structure (verbatim section headers + verbatim 감지 규칙; tables summarized):

> ### 내부 세션 (같은 aterm 앱)
> [table — natural-language phrase → aterm CLI verb: `aterm list` / `aterm inject <ws> '...'` / `aterm status <ws>` / `aterm tasks` / `aterm lessons` / `aterm help`]
>
> ### 외부 세션 (다른 터미널/머신)
> [table: `telepty list`; `telepty inject <session-id> '<message>'`]
>
> ### 감지 규칙
>
> - `$ATERM_IPC_SOCKET` 존재 → aterm 내부 → `aterm` 명령
> - `$ATERM_IPC_SOCKET` 없음 → 외부 → `telepty` 명령

Implication: OQ2 양방향 mesh resolution operationalizes the internal/external split. `bin/aterm.js` is the internal-routing entry point; on local-miss it falls back to `telepty inject` (external bus). aterm publishes its own session lifecycle to the telepty bus so that **other terminals' aterm CLIs** can discover aterm-hosted sessions via `telepty list` — closing the mesh.

#### §3.4.5 Rule 29 surgical edit (HARD RULE)

`~/projects/aigentry-orchestrator/docs/rules.md:349–360` (commit `d9bf7f575be9ae19b16acf584821d406b29a2d0a`, 2026-05-05):

> **변경 라인은 모두 요청에 추적 가능해야 한다.** Drive-by reformatting / unrelated refactor / 인접 코드 스타일 통일 금지. 사전 존재하는 dead code는 **mention만 하고 삭제하지 않는다** (별도 cleanup task로 분리).

Implication: drives OQ4 resolution **(c) 2-Phase split**. Phase 1 = cleanup-only PR (the "별도 cleanup task" Rule 29 prescribes). Phase 2 = feature-only PR with surgical edits attributable to the AttachExternal activation + bus-publish requirements. A single combined PR would mix dead-code removal with feature wiring → Rule 29 violation.

---

## §4 Consequences

### §4.1 Pros (per Constitution Article)

| Article | Pro |
|---|---|
| **Art.1 경량** | Net **−3400 LOC** post-cleanup (architect deep-analysis Appendix B: −3621 dead renderer + ~+200 alias/docs). Removes Tauri/Svelte residue (~5GB archived). |
| **Art.2 크로스** | OQ2 bidirectional mesh: aterm self-sessions discoverable from any other-terminal aterm via `telepty list` bus. OQ1 AttachExternal activation: cross-terminal pill viewer in sidebar. |
| **Art.3 역할** | Role boundary verbatim: aterm = GUI client + Model B PTY owner; telepty = daemon + cross-terminal bus + headless lifecycle. No overlap, no absorption. |
| **Art.5 최선** | No workaround. Real gap (telepty `send-key` Enter-only) fixed at root in Phase 2 sub-PR. AttachExternal scaffolding (lib.rs noop) wired to actual handler — not deleted, not deferred. |
| **Art.9 독립** | aterm runs end-to-end with telepty absent (Model B + aterm-ipc UnixSocket are self-sufficient). Telepty runs without aterm (already true today). |
| **Art.13 비판/건설/객관** | Decision grounded in code-level evidence (architect deep-analysis 537-line audit), not preference. opt-1/opt-2 rejected with reasoning, not dismissal (§5). |
| **Art.17 무의존** | No new external lib / framework. Pure deletion (Phase 1) + alias additions + ~70-100 LOC telepty patch (revised at r3 per codex C3) + bus-event consumer wiring (Phase 2). |

### §4.2 Cons

- **Effort**: **~2-2.5 person-weeks** (Phase 1 ~3–5d + Phase 2 ~3–5d + telepty sub-PR ~2-3d) — revised at r3 from r2's 1.5w (telepty sub-PR ~30 LOC → ~70-100 LOC per codex C3 + lesson F4). Still smallest of the three options (opt-1 ~3.5w / opt-2 ~8-14w) but non-zero.
- **2-phase coordination overhead**: separate PRs, separate review cycles, separate accept gates. Mitigated by Rule 29 — coordination cost is the price of surgical edits.
- **Cross-terminal rendering NOT delivered**: aterm cannot **render** PTY bytes from sessions hosted in other terminals (ghostty/kitty); only **lists** them via `TeleptyBusClient` pill. Acceptable per §3.4.2 (aterm > cmux for aterm-hosted sessions; cross-terminal rendering is opt-1 territory and not user-requested).
- **`bin/aterm.js` cross-terminal fallback latency**: shelling out to `telepty inject` adds process-spawn cost on local-miss. Acceptable: local-miss is by definition rare in dogfood (aterm is the primary host).

### §4.3 Side effects (mostly positive)

- **Cross-LLM synthesis backlog auto-progresses**: tasks **#355** (Ghost crate + dead wgpu cleanup, P1) and **#356** (Tauri/Svelte stack 제거, P1) are absorbed into Phase 1. Both were authored from the 2026-05-05 cross-LLM synthesis (`docs/reports/2026-05-05-aterm-cross-llm-synthesis.md` table "신규 백로그 후보") and gain a forcing function via this ADR.
- **#56** (P0 — telepty inject `--submit` + `send-key` allowlisted keysym) is **directly closed by Phase 2 sub-PR (§6.3)**. The pre-existing backlog item is the same surface (telepty `cli.js:1831–1860` enter-only guard). This ADR is the architectural ratification of #56's resolution.
- **#53** (P0 — aterm telepty-bus binary not found 시 연결 스킵 + exponential backoff) is **adjacent to Phase 2** (AttachExternal activation requires reliable bus-client behavior). Resolution may be folded into Phase 2 dispatch or run in parallel; coordination decided at Phase 2 dispatch time.
- **#57** (P1 — aterm 사이드바 태스크 보드 UI) is **adjacent to Phase 2** (sidebar pill state machine extension lands in the same `SessionSidebarView.swift` surface). Recommend folding into Phase 2 to avoid double-touch of the sidebar source file.
- **#353** (IME 회귀 통합 fix, P0 — cross-LLM synthesis 신규 백로그 후보) is **independent** and may run in parallel with Phase 2 (no file overlap with AttachExternal / bus-publish surface per architect §1 component reference table).
- **#363** (cargo regressions, P1 — FFI panic guard 15 entry points per tester 2026-05-06 dogfood) may run in parallel with Phase 1 (cleanup → smaller compile surface accelerates panic-guard verification).
- `aterm-structure-map.md` rewrite (drop renderer\*/wgpu narrative) is bundled into Phase 1.

---

## §5 Alternatives Considered

Each alternative is grounded in the architect deep-analysis §3 "Option Evaluation" matrix.

### §5.1 opt-1 — aterm = viewer-only for telepty-owned PTYs

- **Effort**: ~3.5 person-weeks (architect §3 opt-1 row).
- **Net new LOC**: +1200 to +1800 (new bus wire-protocol + back-pressure semantics).
- **Why rejected**: Article 9 (독립) violation — aterm becomes telepty-dependent (cannot run without daemon). Memory feedback `aterm > cmux 우선` (§3.4.2) explicitly elevates aterm-hosted sessions; opt-1 inverts the priority by demoting aterm to a renderer over telepty-owned PTYs. Article 1 (경량) violation — adds dual code paths (viewer-mode flag, bus-byte ingress, bidirectional input wire). User has not requested cross-terminal rendering.

### §5.2 opt-2 — aterm replaces cmux as orchestrator UI host

- **Effort**: 8–14 person-weeks (architect §3 opt-2 row).
- **Net new LOC**: +6000 to +12000.
- **Why rejected**: Article 1 (경량) violation — explicit oversteps; many subsystems duplicate cmux (window manager, pane hierarchy, status pill, browser pane bridge, layout engine, tmux-compat). Article 3 (역할) violation — aterm absorbing cmux is the textbook role-침범 case (memory feedback `aterm > cmux 우선` says aterm should *take priority*, **not** *absorb cmux's role*). Article 5 (최선) — good outcome at 5–10× the cost vs opt-3-prime.

### §5.3 opt-3 vanilla (without Phase 1 cleanup)

- **Effort**: ~1.0 person-week (Phase 2 only).
- **Why rejected**: Rule 29 (HARD RULE, §3.4.5) violation risk. Shipping AttachExternal wiring atop ghost-crate + dead-renderer surface mixes feature edits with surrounding ambiguity that future PR review cannot disentangle. Phase 1 first preserves "변경 라인은 모두 요청에 추적 가능" — feature edits in Phase 2 are surgically attributable to AttachExternal/bus-publish requirements only.

### §5.4 status quo (no decision)

- **Why rejected**: dead-code debt + ambiguous Model A scaffolding (per architect §3 "status quo" row) leak grill-grade ambiguity into every future architectural conversation. The 2026-05-05 cross-LLM synthesis (`docs/reports/2026-05-05-aterm-cross-llm-synthesis.md`) already produced backlog #355 + #356 with P1 tags; status quo defers the inevitable while accumulating drift.

---

## §6 Phase Plan (Surgical Edits per Rule 29)

### §6.1 Phase 1 — Cleanup only (~3–5 days)

**Backlog mapping**: closes #355 (P1) + #356 (P1).

| Touch | Action | LOC delta | Source |
|---|---|---:|---|
| `Cargo.toml` (workspace root): remove `[[bin]] aterm-v3`; remove unused root deps `wgpu`, `glyphon`, `winit`, `pollster`; drop `[package]` block if root is purely workspace | delete | -10 to -25 | architect §5 cleanup pre-req |
| `aterm-core/src/renderer.rs` | delete | **-2613** | architect §3.2 dead-renderer trio |
| `aterm-core/src/renderer_atlas.rs` | delete | **-385** | architect §3.2 dead-renderer trio |
| `aterm-core/src/renderer_glyph.rs` | delete | **-623** | architect §3.2 dead-renderer trio |
| `aterm-core/src/lib.rs:51–67` `pub mod {…, renderer, renderer_atlas, renderer_glyph}` decls | delete the 3 module decls | -3 | matches above deletions |
| `aterm-core/src/lib.rs` `#[cfg(feature="wgpu")]` blocks (~30 sites in 56–907) | delete | -200 to -400 | architect §3.2 dead-renderer trio |
| `archived/src-v3-future/` | delete | n/a (archived) | architect §5 cleanup pre-req |
| `archived/src-tauri-v1/` | delete | n/a (archived) | architect §5 cleanup pre-req |
| Root `package.json`, `src/`, `vite.config.js`, `index.html` (Tauri/Svelte residue) | delete | -? (5GB on-disk) | #356 + §3.4.1 v3-only mandate |
| Root `package-lock.json` (~75KB, last touched 2026-03-22) | **delete** — paired with root `package.json`; orphaned post-cleanup since v3-only mandate (§3.4.1) removes the entire npm dependency surface (codex C5 / R3 — closes "stale residue" risk) | small | codex C5 + #356 |
| `scripts/patch-xterm-wk-ime.mjs` (~10KB) | **delete** — patches `node_modules/@xterm/xterm@6.1.0-beta.195` (verified at file:5-17), which only exists under the v2 Tauri/Svelte stack being removed; orphaned post-cleanup. **Retain only IF** `bundle-server.js` / `package-aterm-v3-app.sh` (other entries in `scripts/`) reference `@xterm` — verified at r3 freeze: they do NOT (codex C5 explicit clarification). | small | codex C5; v3-only mandate (§3.4.1) |
| `aterm-structure-map.md` | rewrite (drop renderer\*/wgpu narrative) | refresh | architect §5 cleanup pre-req |

**Phase 1 invariants** (HARD):
- **NO** behavior change. All deletions are unreachable code (gated by undefined `wgpu` feature, missing `src-v3/main.rs`, archived dirs, or mandated v2 stack).
- **NO** feature additions in Phase 1. Surgical removal only (Rule 29 verbatim).
- **G1 verification gate**: `cargo test` must still pass post-Phase-1 (architect deep-analysis empirical 70/72 PASS baseline; the 2 regressions are FFI panic guard and **independent** of cleanup surface per #363).

### §6.2 Phase 2 — Feature (~3–5 days, after Phase 1 acceptance)

**Backlog**: new task TBD on Phase 2 dispatch.

| Touch | Action | Source |
|---|---|---|
| `aterm-core/src/lib.rs:2499` (`AtermHostCallbacks.attach_external_session` extern fn) | wire from no-op host callback to a real handler that registers a sidebar-pill session entry sourced from telepty bus discovery (`TeleptyBusClient` WS :3848 already in tree); **read-only sidebar pill click-through only — NO bus-byte streaming, NO new wire protocol** (bus-byte ingress is opt-1 territory ~600–900 LOC, explicitly rejected per §5.1) | OQ1 α-activate (§2.2); architect §3 opt-3-prime row "switch the active TerminalView to a telepty-discovered session **read-only** (sidebar pill click-through, OK as scaffolding)" |
| `aterm-core/src/lib.rs:2563` (Rust `attach_external_session` body) | implement: emit `SessionAction::AttachExternal` consequence on the EventBus → `SessionSidebarView` shows pill state; click-through opens **read-only sidebar pill state** (not an embedded byte-stream view) | OQ1 α-activate (§2.2) |
| `aterm-core/src/app.rs:851–860` (`SessionAction::AttachExternal` dispatch arm) | match — currently calls host noop; post-Phase-2 the host callback writes through to the new handler | OQ1 α-activate (§2.2) |
| `macos/Sources/AppDelegate.swift` (AttachExternal handler) | match — Swift-side host callback wires to UI viewer state | OQ1 α-activate (§2.2) |
| `aterm-core/src/telepty_bridge.rs` | extend to **publish** aterm self-session lifecycle events to telepty bus (currently registers workspace metadata fire-and-forget; add lifecycle emissions covering session create/close/rename/focus). Top-of-file doc comment updated. **Exact event-payload schema is part of OQ5's deferred writing-plans decision** (event names listed here are illustrative of scope, not normative). | OQ2 양방향 mesh (§2.2) + OQ5 deferred (§7.1) |
| `bin/aterm.js` | add **`inject` alias** (~5 LOC; reuses `cmdSend`'s `Inject` `SessionAction` payload — `inject <workspace> <text>` ↔ `send <workspace> <text>`); closes codex C1 / `aterm-context.md:34` doc-vs-code drift; G4 will exercise the new alias verbatim | codex C1 (review report §6 Finding A); `aterm-context.md:34` documents `aterm inject ghostty 'make build'` |
| `bin/aterm.js` | local-miss fallback: when target workspace unknown locally (UnixSocket returns "not found"), shell out to `telepty inject <session> <text>`; gracefully error if telepty CLI absent (G7/M1) | OQ2 양방향 mesh (§2.2); codex §7 missing gate M1 |
| `bin/aterm.js` | add aliases `rename`, `focus`, `restart`, `wait-until`, `subscribe` (each ~8–15 LOC; underlying `SessionAction` variants already exist in `action.rs:5–80`). **Alias work is bundled in opt-3-prime per architect §3 work table — not a new architectural decision per F1 lesson** | architect §3.3 cmux parity + §5 opt-3-prime work table |
| `bin/aterm.js` | add `aterm identify` (payload shape **deferred to writing-plans** per OQ5 §2.2; alias-bundling rationale same as above row) | architect §3.3 |
| `tests/ipc_roundtrip.rs` (new or extended) | IPC roundtrip for SendKey across the **allowlisted 7-key set** (Enter, Ctrl-C, Ctrl-D, Ctrl-L, Ctrl-Z, Tab, Esc — codex C2), ListWorkspaces, CreateWorkspace, AttachExternal-activated path | architect §5 |
| `docs/architecture/session-control.md` (new) | short architecture note linking architect deep-analysis report + this ADR | architect §5 |

**Phase 2 invariants** (HARD):
- AttachExternal activation MUST NOT introduce a new wire protocol. The bus is `TeleptyBusClient` WS :3848 (already in tree); the activation wires the existing scaffolding into a working state, not a new transport.
- Bidirectional mesh MUST use existing `TeleptyBridge` HTTP path for publish (already fire-and-forget per `telepty_bridge.rs:1–104`); no new bus-protocol surface invented at the aterm layer.
- **SendKey allowlist is FROZEN** at the current 7 distinct keys / 13 spellings per `aterm-core/src/app.rs:992-1008` (codex C2). Phase 2 does NOT expand `is_supported_send_key()` or Swift `keyPayload(for:)`. The telepty sub-PR (§6.3) wires telepty's bus-relayed `send-key` to the **same** allowlist — not broader. Allowlist expansion is a future ADR.
- Coordinate with telepty sub-PR (§6.3) so that Phase 2 release gate is "both PRs merged + telepty version pinned"; Phase 2 alone provides AttachExternal + bus-publish parity but does not unlock cross-terminal allowlisted-keysym `send-key`.

### §6.3 Phase 2 sub-PR — telepty `send-key` allowlisted keysym + aterm UDS routing (separate cycle)

Same dispatch cycle as Phase 2, separate PR in **`aigentry-telepty` repo**. Owner: **orchestrator dispatches** the sub-PR (per codex C6) and tags the resulting telepty release (target tag ≥ `0.3.6`) before Phase 2 is accepted.

| File | Change | LOC |
|---|---|---:|
| `aigentry-telepty/cli.js:1831–1860` | drop `if (key !== 'enter') exit` guard; validate against allowlist (mirrors aterm `is_supported_send_key()` exactly — 7 distinct keys / 13 spellings); pass `keysym` in submit body | ~10 |
| `aigentry-telepty/daemon.js:1475–1548` (`/api/sessions/:id/submit`) | accept `body.keysym`; **dispatch by `session.type`**: aterm → new UDS branch (next row), cmux/kitty/wrapped → `terminalLevelSubmit()` extension below | ~15 |
| `aigentry-telepty/daemon.js:534-643` (`writeDataToSession` aterm branch + `terminalLevelSubmit`) | **NEW: aterm UDS `SendKey` branch** — when `session.type === 'aterm'` and a `keysym` is present, send `{action:"SendKey", workspace:id, key:keysym}` over the same UDS path that today carries `{action:"Inject", ...}` (`daemon.js:534-540`). Mirrors the existing Inject UDS handshake (timeout/error/markSessionDisconnected), so failure semantics match. **Without this branch, `telepty send-key <aterm-session-id> Tab` cannot reach an aterm-hosted PTY** (codex §6 Finding C: today's force path → `terminalLevelSubmit()` only handles kitty/cmux/PTY at `daemon.js:630-643`). | ~30-50 |
| `aigentry-telepty/terminal-backend.js:102+` (after `cmuxSendEnter`) | add `cmuxSendKey(sessionId, keysym)` → `execSync('cmux send-key --surface … <keysym>')`; mirror for kitty backend; called from `terminalLevelSubmit` extension | ~15-25 |
| **Total** | additive, ~3-4 files, **~70-100 LOC** (revised from r2's 30 LOC per codex C3 + lesson F4) | **~70-100** |

**Sub-PR invariants**: additive only (no breaking change to existing `send-key enter` callers). Closes the asymmetry where aterm's `SessionAction::SendKey` accepts an **allowlisted set of 7 distinct keys / 13 string spellings** (per `aterm-core/src/app.rs:992-1008`, codex C2) but telepty's bus-relayed `send-key` does not. Telepty post-sub-PR matches aterm's allowlist exactly (no broader, no narrower); attempts to send keys outside the allowlist return a clear "unsupported keysym" error rather than silently dropping. **Allowlist expansion (e.g., arrow keys, function keys) is explicitly out of scope for r3 / Phase 2** — a future ADR is required to expand both `is_supported_send_key()` (Rust) and `keyPayload(for:)` (Swift) jointly.

---

## §7 Open Questions (Deferred)

### §7.1 OQ5 — Aterm `identify` payload shape

**Status**: deferred to writing-plans (Phase 2 dispatch). API-level detail (which fields: hostname / pid / terminal / workspace name / session-id), not architectural. cmux's `identify` semantics are reference; the final shape is decided when the coder session opens the writing-plans skill on the Phase 2 task.

### §7.2 No new architectural OQs surfaced during ADR write

Per architect §5.3 INVARIANT (force ≥2 alternatives) + lesson F1 (ADR captures grill outcomes only — does not extend), self-review confirmed §2 contains no decisions outside the 5 grill OQs. If review surfaces a new architectural choice, this section absorbs it; r1 has none.

---

## §8 Verification (M0-style gates)

| Gate | Check | When | Source of measurement |
|---|---|---|---|
| **G1** | `cargo test` passes post-Phase-1 cleanup (≥ 70/72 baseline; the 2 known regressions = #363 FFI panic guard, independent) | Phase 1 PR CI | `cargo test --workspace` |
| **G2** | aterm self-session visible in `telepty list` (bus publish landed) | Phase 2 PR | `telepty list --json` shows aterm-hosted workspace entries |
| **G3** | `telepty inject <aterm-session-id> "<text>"` delivers to aterm session | Phase 2 PR + telepty sub-PR | manual or scripted: open aterm session, inject from another terminal, observe text in aterm |
| **G4** | All 7 cmux orchestrator-daily verbs (`list / new / close / inject / send / send-key / read-screen`) execute via `bin/aterm.js` against an aterm-hosted session — **including the new `inject` alias added in Phase 2** (`bin/aterm.js` baseline at r3 covers 6/7 per §3.3 / codex C1) | Phase 2 PR | scripted parity test in `tests/ipc_roundtrip.rs` (must invoke each of the 7 documented verb names verbatim) |
| **G5** | `telepty send-key <session> <non-enter-allowlisted-keysym>` succeeds for **cmux/kitty target** (sub-PR landed) | Phase 2 sub-PR | scripted: `telepty send-key <cmux-session-id> Tab`; verify Tab byte arrives at child PTY (target type asserted explicitly per codex C2/C3) |
| **G6** | AttachExternal activation: clicking a telepty-hosted pill in `SessionSidebarView` opens read-only viewer state without crash | Phase 2 PR | manual UI verification + smoke-test entry |
| **G7** (M1, codex §7) | `aterm inject <external-session-id> "<text>"` local-miss fallback shells out to `telepty inject` and returns a clear error if telepty CLI is absent (no silent failure, no traceback dump) | Phase 2 PR | scripted: invoke against unknown workspace name with telepty CLI present (expect success), then with `PATH=/dev/null` (expect "telepty not found" exit code + readable stderr) |
| **G8** (M2, codex §7) | `telepty send-key <aterm-session-id> Tab` reaches the child PTY through aterm UDS `SessionAction::SendKey` (covers the gap that today's `terminalLevelSubmit()` only handles kitty/cmux/PTY at `daemon.js:630-643`) | Phase 2 sub-PR | scripted: open aterm-hosted session, run `telepty send-key <id> Tab`, assert Tab character (`\t`) arrives at child PTY (capture via `cat`/`od -c`) |

G1 is a **regression gate** (must hold). G2–G8 are **acceptance gates** for Phase 2 closure (G7/G8 added per codex review §7 — M1/M2).

---

## §9 Risks + Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Phase 1 cleanup deletes more than the cross-LLM-identified dead surface (e.g., a `wgpu` block that has runtime use we missed) | medium | **grep verify** before deletion: `rg "renderer|renderer_atlas|renderer_glyph" --type rust` outside the 3 dead files MUST yield only `pub mod` decls in `lib.rs:51–67`. Any reachable reference → escalate; do not delete. |
| Phase 2 telepty bus publish creates cross-talk between aterm-hosted and telepty-hosted sessions | medium | session-id namespacing — `aterm:<workspace-name>` vs telepty native `<session-id>`. `TeleptyBridge` POST body MUST carry `source: "aterm"` so bus consumers can disambiguate. (Implementation detail — refined in writing-plans per OQ5.) |
| Phase 2 sub-PR (telepty `send-key`) breaks existing Enter-only callers | low | additive change: empty/missing `keysym` defaults to `enter` (preserves current behavior). New callers pass explicit keysym. Backward-compat verified by re-running existing telepty test suite. |
| AttachExternal activation creates a partial wire (host callback fires but Swift UI doesn't render) | low | acceptance gate G6 explicit + manual smoke; degraded path = pill visible but click-through is no-op (no crash). Bus-byte streaming is **opt-1 territory and explicitly out of scope** (§5.1, §6.2 row 1) — a future ADR is required to revisit; this ADR does not roadmap it. |
| Coordination drift between Phase 2 (aterm repo) and Phase 2 sub-PR (telepty repo) — one merges before the other | medium | release gate: Phase 2 closure REQUIRES both PRs merged. **Orchestrator (not architect/coder) owns the telepty sub-PR dispatch** (codex C6) — the orchestrator session that runs Phase 2 also dispatches the telepty sub-PR session and tracks both completions. **Phase 2 acceptance MUST record telepty commit-SHA + tag/version (target ≥ `0.3.6`)** that contains the keysym + aterm UDS routing changes. Acceptance note format: `telepty-version: 0.3.6 (commit <sha>)`. |
| #353 IME 회귀 fix (P0, parallel-safe) lands during Phase 2 and conflicts in `TerminalView.swift` / `MetalRenderer.swift` | low | Phase 2 surface (`AppDelegate.swift` AttachExternal handler + `telepty_bridge.rs` + `bin/aterm.js`) does NOT overlap with #353 IME surface. Verified against architect deep-analysis component table §1.3. |
| **R3** (codex §8): Phase 1 cleanup leaves stale residue — root `package-lock.json` (and orphaned `scripts/patch-xterm-wk-ime.mjs`) not addressed in r2 → weakens Art.1 cleanup claim | low-medium | §6.1 Phase 1 table (r3) now lists both files with explicit **delete** disposition + reason. G1 (`cargo test`) is unaffected by these deletions; the lockfile + xterm patch are pure npm/v2 surface. Verified at r3 freeze: `rg "patch-xterm-wk-ime\|@xterm" scripts/` returns only the file itself; no other build script depends on it. |
| **R4** (codex §8): Cross-repo release skew — user installs old telepty (e.g., `0.3.5`) and aterm Phase 2 ships expecting allowlisted-keysym + aterm UDS routing → silent breakage on `telepty send-key <aterm-session> Tab` (G8/M2) | medium | (a) **Phase 2 acceptance gate**: blocked until telepty sub-PR is merged AND tagged (target ≥ `0.3.6`) AND the version pin is recorded in the Phase 2 acceptance note (per C6 row above). (b) **Graceful degradation in aterm**: when `bin/aterm.js` shells out to `telepty inject` (G7/M1) or when telepty's `/submit` returns `error: 'unsupported keysym'` (pre-`0.3.6` daemon), aterm logs a structured warning that names the minimum required telepty version (`telepty ≥ 0.3.6 required for aterm-target send-key; detected: <version>`). No silent fallback; no crash. (c) Implementation detail (version-detection mechanism — `telepty --version` parse vs daemon `/api/version`) deferred to writing-plans per OQ5 INVARIANT (§7.1). |

---

## §10 Constitutional Compliance Check

Constitution: `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 3, 5, 9, 13, 17 (per dispatch §"opt-3-prime 채택 이유" itemization). Each article is checked PASS / FAIL / N/A with one-line evidence per `references/constitution-check.md` discipline.

| Article | Verdict | Evidence |
|---|---|---|
| **Art.1 경량** | **PASS** | Net **−3400 LOC** post-Phase-1 (architect Appendix B: −3621 dead + ~+200 alias/docs). No new framework/library introduced. opt-3-prime is the *minimum* viable session-control surface (architect §3 opt-3-prime constitutional alignment row). |
| **Art.2 크로스** | **PASS** | OQ2 양방향 mesh (§2.2 + §3.4.4) preserves cross-terminal/cross-machine reach: aterm publishes self-sessions to telepty bus; aterm CLI shells out to `telepty inject` on local-miss. OQ1 α-activate puts cross-terminal pills in aterm sidebar via `TeleptyBusClient`. Tailscale (`tailscale.rs` `tsnet`) untouched — cross-machine path preserved. |
| **Art.3 역할** | **PASS** | Role boundary held verbatim: aterm = GUI client + Model B PTY owner; telepty = daemon + cross-terminal bus + headless lifecycle (per §3.4.3). OQ3 미지원 explicitly preserves headless ownership in telepty. opt-2 (cmux absorption) rejected for explicit Art.3 violation (§5.2). |
| **Art.5 최선** | **PASS** | No workaround. Real telepty `send-key` Enter-only gap fixed at root (Phase 2 sub-PR §6.3). AttachExternal scaffolding wired through (OQ1 α), not deleted-and-defer or downgraded-only. Phase 1 ratifies v3-only mandate at the file level (§3.4.1) — no half-measure. |
| **Art.9 독립** | **PASS** | aterm runs end-to-end with telepty absent (Model B + `aterm-ipc` UnixSocket, verified by architect §3.2 row 2 + §1 component reference table). Telepty runs without aterm (already true today). opt-1 rejected for explicit Art.9 violation (§5.1). |
| **Art.13 비판/건설/객관** | **PASS** | Decision grounded in architect deep-analysis 537-line code-level audit (`docs/reports/2026-05-06-aterm-session-control-architecture.md`). All 5 grill OQ resolutions cite specific direction documents (§3.4) — no preference-only basis. opt-1 / opt-2 rejected with reasoning (§5), not dismissal. |
| **Art.17 무의존** | **PASS** | No external lib / plugin / framework introduced. Phase 1 = pure deletion. Phase 2 = additive wiring on existing surfaces (`TeleptyBusClient` WS, `TeleptyBridge` HTTP, `aterm-ipc` UnixSocket, `SessionAction` enum). Sub-PR = **~70-100 LOC** (revised at r3 per codex C3 — adds aterm UDS `SendKey` branch in `daemon.js`) stdlib-only telepty patch. |

**Verdict**: **PASS overall**. **7/7 articles** satisfied. No FAIL on any required article.

---

*Compiled 2026-05-06 by `aigentry-architect-aterm-adr` · model: claude-opus-4-7 · captures grill outcomes 5/5 · NOT committed pending orchestrator decision + spec-document-reviewer PASS gate.*
