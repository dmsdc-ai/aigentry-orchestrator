---
status: draft
date: 2026-04-19
topic: ecosystem-contract-doc
track: E-eco-sync (#297)
related: [#294 L1 compact/switching, #295 cancelled — MCP contract unification]
---

# Ecosystem Contract Documentation — Design Spec

## §1 Goal

aigentry 에코시스템의 컴포넌트별 contract를 **단일 가이드 문서**로 정리. LLM 세션과 인간 orchestrator 모두 "어느 컴포넌트를 어떤 상황에 어떻게 호출하는가"를 빠르게 찾게 함.

## §2 Constraints

1. 새 코드 0 (문서만)
2. 새 MCP 서버/tool 0
3. 컨텍스트 세금 0 (auto-load 안 함 — 필요 시 수동 참조)
4. 기존 구조 재정의 X (사실 그대로 문서화)

## §3 Non-Goals

- 컴포넌트 재설계 제안
- 새 contract 제정 (이미 있는 것만 기술)
- 이행 가이드 (migration guides are separate)

## §4 Target Audience

| 독자 | 사용 시나리오 |
|------|-------------|
| LLM 세션 (claude/codex/gemini) | 도구 선택 시 참조 (세션이 필요 시 `@ecosystem-contract.md` import) |
| 인간 orchestrator | 새 컴포넌트 추가 시 contract 결정 |
| 외부 사용자 | aigentry 생태계 onboarding |
| 신규 세션 (onboarding) | 첫 세션에서 "무엇을 쓸 수 있는가" 파악 |

## §5 Document Structure

### §5.1 Components Overview Matrix (§1 of document)

두 카테고리로 분리: **서비스/도구**(코드 컴포넌트) + **역할 세션**(role-per-folder 컨벤션).

#### 5.1.1 Services & Tools

| 컴포넌트 | Contract | Install | 주 호출자 | 용도 | Lifecycle | Last-verified |
|---------|---------|---------|---------|------|----------|:--------:|
| brain | MCP | `npm i -g @dmsdc-ai/aigentry-brain` + `claude mcp add` | LLM | 장기 구조화 기억 | long-term | _작성일_ |
| deliberation | MCP | `npm i -g @dmsdc-ai/aigentry-deliberation` + `claude mcp add` | LLM | 멀티-agent 토론 | session→persistent | _작성일_ |
| wtm (하위: wtm-context, wtm-create 등) | bash+file | `aigentry-devkit/install.sh` | hook/orchestrator/human | 워크트리/세션 라이프사이클 | ephemeral | _작성일_ |
| task-queue | bash+JSON | 프로젝트 `state/task-queue.json` | orchestrator/hook | 태스크 보드 | per-project | _작성일_ |
| telepty | bash+socket | `aigentry-telepty` cargo install | hook/session/orchestrator | 세션 간 real-time 통신 | per-session | _작성일_ |
| aterm | bash+socket | aterm app 설치 (macOS) | session (aterm 내부) | 세션 container + 내부 IPC | per-session | _작성일_ |
| auto-memory | file (markdown) | Claude Code 내장 | Claude auto | 세션 간 Claude 기억 | long-term | _작성일_ |

#### 5.1.2 Role Sessions (role-per-folder convention)

역할 기반 세션은 "컴포넌트"라기보다 **작업 디스패치 대상**. CLI로 열린 세션이 특정 role MD/template을 로드하여 역할 수행. Contract = "orchestrator가 telepty inject로 호출".

| 세션 패턴 | 주 용도 | 호출 방법 | 관련 MD |
|---------|--------|---------|--------|
| aigentry-architect-* | 시스템 설계, ADR 작성, 트레이드오프 분석 | `telepty inject <sid> "<spec>"` | `aigentry-architect/AGENTS.md` |
| aigentry-analyst-* | runtime 로그/데이터 분석, 판단 | 동일 | `aigentry-analyst/AGENTS.md` |
| aigentry-builder-* | 빌드, 앱 실행, 배포 | 동일 | `aigentry-builder/AGENTS.md` |
| aigentry-tester-* | 테스트 실행, TC 축적 | 동일 | `aigentry-tester/AGENTS.md` |
| aigentry-logger-* | 로그 수집, 전달 | 동일 | `aigentry-logger/AGENTS.md` |
| aigentry-dustcraw-* | 외부 리서치, 웹 검색 | 동일 | `aigentry-dustcraw/AGENTS.md` |
| aigentry-{project}-* | 해당 프로젝트 코드 구현 | 동일 | 해당 project AGENTS.md |

role → 실제 작업 흐름은 §5.3 Decision Tree + `aigentry-orchestrator/AGENTS.md` "전담 세션 역할" 표 참조.

### §5.2 Contract per Component (§2 of document)

각 컴포넌트 별로 다음을 명시:
- **Invocation pattern** (MCP tool call / bash CLI / file read)
- **State location** (MCP server, `~/.aigentry/`, 프로젝트 파일, 등)
- **Lifecycle** (ephemeral / long-term / per-session / per-project)
- **Example** (가장 흔한 호출 예 3개)
- **When to use / When NOT**

### §5.3 Decision Tree (§3 of document)

```
Q: "LLM이 직접 MCP tool 호출해야 하는가?"
├─ YES → Q: "구조화된 Entry (category/scope) 필요?"
│         ├─ YES → brain (learning/decision/summary/fact 등 Entry Category 사용)
│         └─ NO → Q: "멀티-agent 토론 세션?"
│                   ├─ YES → deliberation (deliberation_start 등)
│                   └─ NO → bash CLI로 충분 (LLM이 Bash tool로 직접 호출)
│                           예: `wtm context resume`, `tq-status`, `telepty inject`
│
└─ NO (인간/hook/orchestrator 호출) →
          Q: "Real-time 세션 간 통신?"
          ├─ YES → telepty (inject/broadcast) 또는 aterm inject (aterm 내부)
          └─ NO → Q: "Persistent state?"
                    ├─ YES → task-queue (태스크 진행) 또는 wtm-context (세션 handoff/journal)
                    └─ NO → 단순 bash tool/script (예: `trust-path.sh`, `open-session.sh`)

Q: "데이터 생명주기 — ephemeral vs long-term?"
├─ 세션 종료 후에도 의미 → brain (Entry) / git commit / Claude auto-memory
├─ 세션 한정 (open files, pending tasks) → wtm-context (journal/handoff)
└─ 프로젝트 전반 작업 추적 → task-queue
```

**Dead-end 해결 원칙**: "재검토" 같은 ambiguous 분기 금지. 모든 leaf는 **구체 컴포넌트명 또는 "해당 없음 — 사용 사례 재평가 필요 (Anti-Pattern §5.5 참조)"** 로 종료.

### §5.4 Examples (§4 of document)

5-7 개 대표 시나리오:
1. **ADR 결정 기록** → brain category=decision scope=app:{project}
2. **세션 간 파일 수정 handoff** → wtm context handoff
3. **긴급 메시지 세션 간 전달** → telepty inject
4. **태스크 진행 상태** → tq-status / task-queue.json
5. **compact 발생 시 state 보존** → ctx-router (**#294 L1 기능 — 구현 후 활성. 미구현 단계에는 "수동 `.context-snapshot.md` 작성 + `/compact`" 로 대체** 로 문서에 명시)
6. **세션 재개 시 이전 context 복원** → wtm context resume + brain_query
7. **외부 라이브러리 조사 결과 기록** → brain category=learning

각 예시에 실제 bash/MCP call + 기대 결과 명시. **#294 의존 예시는 의존 상태를 명시 (구현됨/미구현)**.

### §5.5 Anti-Patterns (부록)

- brain에 ephemeral state 저장 (§Inv 위반 — brain 본질 흐림)
- wtm-context에 long-term learning 저장 (journal 팽창, 검색 불가)
- MCP 서버 증설로 "contract 통일" 시도 (컨텍스트 세금 증가, 실제 문제 해결 안 됨 — #295 cancelled 참조)

## §6 File Layout

```
aigentry-devkit/
  docs/
    ecosystem-contract.md   (~300줄, 단일 문서)
  AGENTS.md                 (기존 — 아래 §6.1 포인터 1줄 추가)
```

### §6.1 Discoverability Pointer

신규 세션이 문서 존재를 알 수 있도록 **aigentry-devkit/AGENTS.md**에 1줄 포인터만 추가 (내용 중복 X, auto-load X):

```markdown
## References
- Ecosystem contracts: `docs/ecosystem-contract.md` — 컴포넌트별 contract/호출/decision tree
```

이 1줄만으로 세션이 필요 시 명시적 `@docs/ecosystem-contract.md` import 가능. 컨텍스트 세금 0 (참조만).

## §7 Content Sources

기존 aigentry 문서/코드에서 추출:
- `aigentry-brain/AGENTS.md` + `src/context/` → brain contract
- `aigentry-deliberation/AGENTS.md` → deliberation contract
- `aigentry-devkit/tools/wtm/` → wtm contract
- `aigentry-orchestrator/AGENTS.md` rule 7-1/9/15/16 → orchestration patterns, role sessions 표
- `aigentry-telepty/` source → telepty contract
- 각 role project AGENTS.md (architect/analyst/builder/tester/logger/dustcraw) → role session rows

**No new facts 원칙**: source 문서가 silent한 항목은 공백 + `⚠️ 확인 필요` 태그 (추정 금지). 작성 후 각 maintainer가 공백 채움.

## §8 Testing Plan

| 유형 | 검증 |
|------|------|
| 리뷰 | 각 컴포넌트 maintainer가 자기 섹션 정확성 확인 (claude/codex/gemini 세션 병렬 리뷰 가능) |
| 사용성 | 신규 세션 (fresh claude)에게 "X 시나리오에서 어느 컴포넌트 쓰나?" 질문 → 문서만으로 답변 가능 여부 |
| 완전성 | aigentry 에코시스템의 모든 활성 컴포넌트 포함 (미포함 시 아카이브 대상) |

## §9 Risks

| 리스크 | 완화 |
|-------|------|
| 컴포넌트 추가 시 문서 업데이트 누락 | CONTRIBUTING에 "새 컴포넌트 → ecosystem-contract.md 업데이트 필수" 추가 |
| 구식 정보 (컴포넌트 변경) | 각 row의 Last-verified 컬럼 + 분기별 기본 검토 + 컴포넌트 AGENTS.md 변경 시 자동 flagging (mtime 비교 CI job — 옵션, 별도 태스크 가능) |
| 과도한 상세화 → 유지보수 비용 | ~300줄 상한 엄수. 초과 시 Out-of-Scope 이동 |
| §5.5 Anti-Patterns가 각 §5.2 "When NOT to use"와 중복 가능 | 최종 문서 작성 시 둘 중 한쪽에 집중 (스크롤 절약). 교차 참조는 한 줄만 |

## §10 Dependencies

- 기존 AGENTS.md / SKILL 문서들 (read-only)
- aigentry-devkit 리포지토리 (문서 commit 대상)

## §11 Migration

단일 phase:
1. Draft 작성 (writer 세션 위임, 0.5일)
2. 각 컴포넌트 maintainer 병렬 리뷰 (세션 위임, 0.5일)
3. 수정 반영 + commit (0.5일)

총 1.5일.

## §12 Success Metrics

- 신규 세션이 "어느 도구 쓸까?" 결정 시 이 문서 1번 조회로 결정 가능
- 컴포넌트 maintainer가 자기 섹션에 기술적 오류 없다고 승인
- 에코시스템 신규 진입자 onboarding 시간 단축 (정성적)

## §13 Out-of-Scope

- 각 컴포넌트 내부 구현 문서 (AGENTS.md 유지)
- Migration guide (버전 전환용 — 별도 문서)
- API reference (MCP tool schema는 MCP discovery로 이미 노출됨)
