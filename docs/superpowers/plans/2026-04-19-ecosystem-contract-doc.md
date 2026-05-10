---
multi_exec:
  enabled: true
  coder_session: E22-coder-294
  cleanup_on_success: true
  preserve_on_error: true
---

# Ecosystem Contract Documentation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aigentry 에코시스템의 컴포넌트별 contract를 정리한 단일 가이드 문서(`ecosystem-contract.md`)를 작성하여 LLM 세션과 인간 orchestrator의 discoverability를 개선한다.

**Architecture:** 단일 markdown 파일 (~300줄, 5 section). 기존 AGENTS.md 파일들에서 사실만 추출 (no new facts). devkit AGENTS.md에 1줄 pointer 추가로 discoverability 확보. 컨텍스트 세금 0 (auto-load 안 함).

**Tech Stack:** markdown 작성만. shellcheck/bats 불필요.

**Spec reference:** `docs/superpowers/specs/2026-04-19-ecosystem-contract-doc-design.md`

---

## File Structure

| 파일 | 유형 | 역할 | 크기 |
|------|------|------|------|
| `aigentry-devkit/docs/ecosystem-contract.md` | create | 단일 가이드 문서 | ~300줄 |
| `aigentry-devkit/AGENTS.md` | modify | References 섹션에 1줄 pointer 추가 | +2줄 |

---

## Chunk 1: Source 조사 + 문서 초안 + 리뷰

### Task 1: Source 문서 조사

**Files:**
- Read only (no write): 아래 목록

- [ ] **Step 1.1: 각 컴포넌트 AGENTS.md 발췌**

Read:
- `aigentry-brain/AGENTS.md` — brain contract, 장기 기억 역할, MCP 등록 방법
- `aigentry-deliberation/AGENTS.md` — deliberation contract, state machine, MCP tools 28개
- `aigentry-devkit/tools/wtm/` 관련 README/스크립트 상단 주석 — wtm-context 서브커맨드, journal/handoff 역할
- `aigentry-orchestrator/AGENTS.md` — rule 7-1/9/15/16, 전담 세션 역할 표 (§CLI별 역할 분담)
- `aigentry-telepty/README.md` 또는 상단 주석 — telepty bus, inject/list/broadcast
- `aigentry-aterm/AGENTS.md` — aterm 세션 container, 내부 IPC 명령
- `~/.claude/projects/-Users-duckyoungkim-projects/memory/MEMORY.md` — auto-memory 동작
- 각 role project AGENTS.md (architect/analyst/builder/tester/logger/dustcraw) — role session contract

- [ ] **Step 1.2: 발췌 결과를 스크래치 노트로 구조화**

스크래치 파일 `/tmp/ecosystem-contract-sources.md` 작성:
```markdown
# Source Extract Notes

## brain
- contract: MCP
- install: npm + claude mcp add
- 주 호출자: LLM
- 용도: ...
- example: ...

## deliberation
...
(각 컴포넌트별 동일 구조)
```

**No new facts 원칙**: source에 없는 정보는 공백 + `⚠️ 확인 필요` 태그.

- [ ] **Step 1.3: 커밋 불필요 (스크래치만)**

---

### Task 2: §1 Components Matrix 작성

**Files:**
- Create: `aigentry-devkit/docs/ecosystem-contract.md`

- [ ] **Step 2.1: 문서 헤더 + §1.1 Services & Tools 표 작성**

```markdown
# aigentry Ecosystem Contract Reference

이 문서는 aigentry 에코시스템의 컴포넌트별 contract + 호출 방법 + 사용 시점을 정리한다. LLM 세션과 인간 orchestrator가 "어느 컴포넌트를 어떻게 쓰나"를 빠르게 파악하는 용도.

**Target audience**: LLM 세션 (claude/codex/gemini), 인간 orchestrator, 외부 사용자, 신규 세션.

**이 문서가 아닌 것**: 각 컴포넌트의 내부 구현 문서 (AGENTS.md 유지), Migration guide, API reference.

---

## §1 Components Overview

### §1.1 Services & Tools

| 컴포넌트 | Contract | Install | 주 호출자 | 용도 | Lifecycle | Last-verified |
|---------|---------|---------|---------|------|----------|:--------:|
| brain | MCP | `npm i -g @dmsdc-ai/aigentry-brain` + `claude mcp add` | LLM | 장기 구조화 기억 | long-term | 2026-04-19 |
| deliberation | MCP | `npm i -g @dmsdc-ai/aigentry-deliberation` + `claude mcp add` | LLM | 멀티-agent 토론 | session→persistent | 2026-04-19 |
| wtm (하위: wtm-context 등) | bash+file | `aigentry-devkit/install.sh` | hook/orchestrator/human | 워크트리/세션 lifecycle | ephemeral | 2026-04-19 |
| task-queue | bash+JSON | 프로젝트 `state/task-queue.json` | orchestrator/hook | 태스크 보드 | per-project | 2026-04-19 |
| telepty | bash+socket | `cargo install aigentry-telepty` | hook/session/orchestrator | 세션 간 real-time 통신 | per-session | 2026-04-19 |
| aterm | bash+socket | aterm app 설치 (macOS) | session (aterm 내부) | 세션 container + 내부 IPC | per-session | 2026-04-19 |
| auto-memory | file (markdown) | Claude Code 내장 | Claude auto | 세션 간 Claude 기억 | long-term | 2026-04-19 |
```

- [ ] **Step 2.2: §1.2 Role Sessions 표 추가**

```markdown
### §1.2 Role Sessions (role-per-folder convention)

역할 기반 세션은 "컴포넌트"라기보다 **작업 디스패치 대상**. Contract = "orchestrator가 `telepty inject`로 호출".

| 세션 패턴 | 주 용도 | 호출 방법 | 관련 MD |
|---------|--------|---------|--------|
| aigentry-architect-* | 시스템 설계, ADR 작성, 트레이드오프 분석 | `telepty inject <sid> "<spec>"` | `aigentry-architect/AGENTS.md` |
| aigentry-analyst-* | runtime 로그/데이터 분석 (이미 발생한 일) | 동일 | `aigentry-analyst/AGENTS.md` |
| aigentry-builder-* | 빌드, 앱 실행, 배포 | 동일 | `aigentry-builder/AGENTS.md` |
| aigentry-tester-* | 테스트 실행, TC 축적 | 동일 | `aigentry-tester/AGENTS.md` |
| aigentry-logger-* | 로그 수집 + 전달 (판단 X) | 동일 | `aigentry-logger/AGENTS.md` |
| aigentry-dustcraw-* | 외부 리서치, 웹 검색, upstream 조사 | 동일 | `aigentry-dustcraw/AGENTS.md` |
| aigentry-{project}-* | 해당 프로젝트 코드 구현 | 동일 | 해당 project AGENTS.md |

role 간 구분: `aigentry-orchestrator/AGENTS.md` "전담 세션 역할" 표 참조.
```

- [ ] **Step 2.3: Commit**

```bash
git -C aigentry-devkit add docs/ecosystem-contract.md
git -C aigentry-devkit commit -m "docs(ecosystem-contract): §1 components matrix (services + role sessions) (#297)"
```

---

### Task 3: §2 Contract per Component

**Files:**
- Modify: `aigentry-devkit/docs/ecosystem-contract.md`

- [ ] **Step 3.1: 각 컴포넌트별 ~15-20줄 블록 추가**

Task 1.2 스크래치 기반, 아래 포맷으로 7개 서비스/도구 각각 작성:

```markdown
## §2 Contract per Component

### §2.1 brain

- **Invocation**: MCP tool call (`mcp__brain__*`)
- **State location**: `~/.aigentry/brain/` (profile + entries.jsonl)
- **Lifecycle**: long-term (structured knowledge graph)
- **Example**:
  ```
  brain_append(scope="app:aterm", category="decision", content="ADR-264 race fix")
  brain_query(scope="app:aterm", category="decision", tags=["race"])
  ```
- **When to use**: 세션 종료 후에도 의미 있는 structured fact (learning/decision/invariant)
- **When NOT to use**: ephemeral session state (open files, pending tasks) — wtm-context로

### §2.2 deliberation
...(동일 포맷)
```

7개 블록 한 번에 작성. 각 ~15줄 × 7 = ~105줄.

**No new facts 원칙**: source에 없는 칸은 `⚠️ 확인 필요` 표기.

- [ ] **Step 3.2: per-component 크기 확인 — 상한 ~20줄 엄수**

```bash
awk '/^### §2\./{s=$0} /^### §2\./{n++} s{c[s]++} END{for(k in c) print c[k], k}' aigentry-devkit/docs/ecosystem-contract.md
```
각 블록 20줄 초과 시 요약.

- [ ] **Step 3.3: Commit**

```bash
git -C aigentry-devkit add docs/ecosystem-contract.md
git -C aigentry-devkit commit -m "docs(ecosystem-contract): §2 contract per component (7 entries) (#297)"
```

---

### Task 4: §3 Decision Tree + §4 Examples + §5 Anti-Patterns

**Files:**
- Modify: `aigentry-devkit/docs/ecosystem-contract.md`

- [ ] **Step 4.1: §3 Decision Tree**

스펙 §5.3 디자인 그대로. dead-end 방지 원칙 포함:

```markdown
## §3 Decision Tree

### "어느 컴포넌트를 써야 하는가"

```
Q: LLM이 직접 MCP tool 호출해야 하는가?
├─ YES → Q: 구조화된 Entry (category/scope) 필요?
│         ├─ YES → brain (learning/decision/summary/fact/invariant)
│         └─ NO → Q: 멀티-agent 토론 세션?
│                   ├─ YES → deliberation
│                   └─ NO → bash CLI로 충분 (Bash tool 직접 호출)
│                           예: wtm context resume, tq-status, telepty inject
└─ NO (hook/orchestrator/human) →
          Q: Real-time 세션 간 통신?
          ├─ YES → telepty (inject/broadcast) 또는 aterm inject (aterm 내부)
          └─ NO → Q: Persistent state?
                    ├─ YES → task-queue (태스크 진행) 또는 wtm-context (세션 handoff)
                    └─ NO → 단순 bash tool/script
```

### "데이터 생명주기"

```
세션 종료 후에도 의미 있음 → brain / git commit / Claude auto-memory
세션 한정                 → wtm-context (journal/handoff)
프로젝트 전반 작업 추적    → task-queue
```

**Dead-end 해결 원칙**: 모든 leaf는 구체 컴포넌트명 또는 "해당 없음 — Anti-Pattern §5 참조"로 종료. ambiguous 분기 금지.
```

- [ ] **Step 4.2: §4 Examples (5-7개)**

```markdown
## §4 Examples

### §4.1 ADR 결정 기록
```
brain_append(scope="app:aterm", category="decision", content="ADR-264 withProjectLock reuse")
```

### §4.2 세션 간 파일 수정 handoff
```
wtm context handoff <sid> "finished rendering fix" ...
```

### §4.3 긴급 메시지 세션 간 전달
```
telepty inject <target-sid> "urgent: build failing on main"
```

### §4.4 태스크 진행 상태
```
tq-status
# 출력: 현재 active track, pending/in_progress/done 분포
```

### §4.5 compact 발생 시 state 보존 (#294 L1 의존)
**이 기능은 #294 구현 완료 시 활성**. 미구현 단계에서는 수동으로 `.context-snapshot.md` 작성 후 `/compact` 실행.
구현 후: Claude Code가 PreCompact hook을 통해 자동 ctx-router 호출.

### §4.6 세션 재개 시 context 복원
```
wtm context resume <sid>
brain query --scope "session:<sid>" --slot conversation_summary
```

### §4.7 외부 라이브러리 조사 결과 기록
```
brain_append(scope="app:<project>", category="learning", content="cosmic-text #485: grapheme cluster issue")
```
```

- [ ] **Step 4.3: §5 Anti-Patterns**

```markdown
## §5 Anti-Patterns

에코시스템 본질을 해치는 잘못된 사용. 반복 금지.

- **brain에 ephemeral state 저장** — 예: "현재 열린 파일: renderer.rs" 같은 일회성 state를 brain entry로. brain category 체계 오염 + retrieval 품질 저하. → wtm-context journal로.
- **wtm-context에 long-term learning 저장** — 예: ADR 결정을 journal.jsonl에만. journal 팽창 + 검색 불가. → brain category=decision으로.
- **MCP 서버 증설로 "contract 통일" 시도** — 모든 bash tool을 MCP로 래핑. 매 세션 tool schema 컨텍스트 세금 증가 + 실제 호출자 부담 감소 X. → 각 컴포넌트는 용도에 맞는 contract 유지 (MCP/bash/socket). (cf. #295 cancelled)
- **세션이 hook 없이 수동 snapshot** — 예: 매 task 완료 시마다 수동으로 `wtm context handoff`. hook (git, tq, session end)으로 자동화. → #294 L1 glue 활용.
```

- [ ] **Step 4.4: Commit**

```bash
git -C aigentry-devkit add docs/ecosystem-contract.md
git -C aigentry-devkit commit -m "docs(ecosystem-contract): §3 decision tree + §4 examples + §5 anti-patterns (#297)"
```

---

### Task 5: Discoverability pointer + 크기 검증

**Files:**
- Modify: `aigentry-devkit/AGENTS.md`

- [ ] **Step 5.1: devkit AGENTS.md에 References 섹션 1줄 추가**

`aigentry-devkit/AGENTS.md` 끝이나 기존 References 섹션에 추가:
```markdown
## References

- Ecosystem contracts: `docs/ecosystem-contract.md` — 컴포넌트별 contract/호출/decision tree
```

auto-load 하지 않음. 필요 시 세션이 명시적 `@docs/ecosystem-contract.md` 호출로 참조.

- [ ] **Step 5.2: 문서 크기 검증**

```bash
wc -l aigentry-devkit/docs/ecosystem-contract.md
```
Expected: ~300줄 (250-350 범위 허용). 350 초과 시 §2 블록 축소.

- [ ] **Step 5.3: 사용성 테스트 (fresh session 시뮬레이션)**

신규 claude 세션 열어 다음 질문 문서만으로 답 가능 여부 확인:
1. "ADR 결정은 brain과 wtm-context 중 어디에?"
2. "세션 crash 후 복구는 어느 명령?"
3. "긴급 메시지 다른 세션에 전달은?"
4. "task-queue에 done 전이시 brain에 자동 기록되나?"

각 질문이 문서 1번 조회로 답 가능해야 통과.

- [ ] **Step 5.4: Commit**

```bash
git -C aigentry-devkit add AGENTS.md
git -C aigentry-devkit commit -m "docs(AGENTS): add ecosystem-contract.md pointer (#297)"
```

---

### Task 6: Maintainer 병렬 리뷰

**Delegation** (orchestrator가 dispatch):

- [ ] **Step 6.1: 각 컴포넌트 maintainer 세션에 자기 섹션 리뷰 inject**

오케스트레이터 실행:
```bash
# brain 섹션 리뷰
telepty inject aigentry-brain-claude "REVIEW: docs/ecosystem-contract.md §1.1 brain row + §2.1 brain block. 사실 정확성 + 빠진 정보 확인. 응답은 telepty inject로 orchestrator에 REPORT: <verdict + issues>"

# deliberation 섹션 리뷰
telepty inject aigentry-deliberation-claude "REVIEW: §1.1 deliberation + §2.2 deliberation block. 동일 프로토콜."

# (wtm, task-queue, telepty, aterm 도 동일 — 해당 세션 존재 시)
```

세션이 없으면 dustcraw가 대표로 각 AGENTS.md와 비교하여 리뷰.

- [ ] **Step 6.2: 리뷰 결과 반영**

각 maintainer REPORT 수집 후 issues 반영. 수정 후 재리뷰 필요 시 재dispatch.

- [ ] **Step 6.3: 최종 commit**

```bash
git -C aigentry-devkit add docs/ecosystem-contract.md
git -C aigentry-devkit commit -m "docs(ecosystem-contract): reflect maintainer reviews (#297)"
```

---

## Chunk 1 Review Gate

Dispatch plan-document-reviewer for Chunk 1.

---

## Delegation Plan (오케스트레이터)

| 작업 | 위임 세션 | 비고 |
|------|---------|------|
| Task 1-5 (문서 초안) | aigentry-devkit-claude (writer 역할 inject) | 단일 세션에 SPEC FIRST + 전체 Task sequential |
| Task 6 (Maintainer 리뷰) | 각 컴포넌트 세션 병렬 | 활성 세션만 대상, 비활성은 dustcraw 대행 |
| 최종 검증 | 이 세션 (오케스트레이터) | fresh session 사용성 테스트는 오케스트레이터가 직접 simulation 가능 |

각 inject에 SAWP envelope + MANDATORY report + [IMPLEMENT APPROVED] 플래그 포함.

---

## Success Criteria

- [ ] 문서 크기 300줄 (250-350 허용)
- [ ] `⚠️ 확인 필요` 태그 0 (merge 시점)
- [ ] 각 컴포넌트 maintainer 승인
- [ ] Fresh session 사용성 질문 4개 모두 문서 1회 조회로 답변 가능
- [ ] `aigentry-devkit/AGENTS.md` pointer 1줄 추가됨
- [ ] git commit 4-5개 (§1 matrix / §2 contracts / §3-5 tree+examples+antipatterns / pointer / maintainer-review 반영)

---

## Out-of-Scope

- 각 컴포넌트 내부 구현 문서 (AGENTS.md 유지)
- 다국어 번역
- 자동 검증 CI job (mtime 비교 등 — 별도 태스크 가능)
- API reference (MCP discovery로 이미 노출)
