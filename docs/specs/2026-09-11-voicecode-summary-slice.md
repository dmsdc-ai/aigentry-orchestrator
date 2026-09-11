# Voice Code faithful spoken summary — first pure component slice (#1157)

**Status**: SPEC for review; not approved for implementation. Documentation only: nothing was implemented, built, tested, installed or run. It defines ONE pure Kotlin production file and ONE tester-owned JUnit file. The component stays unwired: after both files land, Voice Code speaks exactly what it speaks today. This is not end-to-end TTS and not audible product functionality until the unresolved adapter (§7) exists.
**Currentness** (measured 2026-09-11T14:41Z): branch `docs/1157-summary-slice`, base `e5610f5` (clean before this file). Local orchestrator `main` `cf4943c` (2026-09-11T23:29+09:00); base is its ancestor; `base..main` touches only `state/dispatch/2026-09-11-vb1157-authority-boundary.md`, `state/dispatch/2026-09-11-vs1157-summary-slice.md` and `state/task-queue.json`. `origin/main` `a536cd8` was not fetched. Source `/Users/duckyoungkim/projects/voicecode` @ `5d98d60` (`main`), dirty state unchanged and preserved: ` D .omc/state/subagent-tracking.json`, `?? .claude/` (not opened).
**Not measured**: no build, test, app, device or daemon run; no fetch; Claude stream-json schema not researched; TTS vocalisation not measured; the vb1157 authority document was not read (this slice does not depend on it). Core `docs/specs/2026-09-11-voicecode-core-contract.md` §6 and the UI contract were read as context only.
**Labels**: S = source `file:line` @ `5d98d60` (Kotlin under `android/app/src/main/java/com/voicecode/app/`, TS under `bridge/src/`) · P = proposal (constants and wording, not measured) · U = unknown, needs the named evidence.

## 1. Boundary

- `SpokenSummaryComposer.compose(facts, length)` is a total pure function. Typed, source-linked facts go in. Ordered spoken segments plus provenance and status metadata come out. It performs no I/O, network access, provider/LLM call, clock read, randomness, logging, locale lookup, action dispatch, audio playback, queueing, priority or interrupt choice, question state change or authority decision.
- Questions are read-only information. The composer counts pending questions and passes their opaque refs through. It cannot make a question answerable, issue a challenge or readback, close a question or authorize anything. Exact approval readback stays a separate core dependency.
- The output has no delivered, played, heard or acknowledged field. Playback of a summary never counts as evidence that the user heard, understood or approved it. Stopping playback is not task cancellation: the composer never cancels, and it renders `CANCELLED` without naming who cancelled.
- Out of scope here: protocol, grants, UI, routes, providers, engines and the audio ledger. The slice is independent of the unresolved host placement, external-cloud audio consent and hands-free grant scope/duration/limit choices, and it approves none of them.
- The composer guarantees the presence, order and attribution of decision-critical fields. It does not guarantee the semantic truth of agent prose.

## 2. Measured source (why one new file, why here)

| Fact | Evidence (S) | Consequence |
|---|---|---|
| Every `speak` ends in built-in TTS; bridge TTS is a TODO | `voice/VoiceEngineManager.kt:95-110` | composer output is text only; no engine claim |
| `speak(HIGH)` stops speech and clears the queue | `voice/TtsManager.kt:95-99` | later wiring must speak `summary.text` as ONE utterance; per-segment HIGH calls would keep only the last segment |
| Speech is dropped silently when TTS is not initialised; spoken text is logged | `voice/TtsManager.kt:85-90` | core concern; the composer never logs |
| Bridge path: `CliOutput` → `ContextCompressor.compress` → speak; bridge error text spoken raw | `viewmodel/MainViewModel.kt:1296-1322,1342-1358` | unchanged by this slice |
| SSH path: screen snapshot after 1500 ms quiet → regex question/error detection → billed `gpt-4o-mini` summary whenever a key exists, else templates | `viewmodel/MainViewModel.kt:290-297,314-423`; `engine/TtsSummarizer.kt:69-123` | heuristic; must never supply composer facts |
| `optimizeForTts` shortens paths to stems, expands `TS`/`API`, strips `~`, `@`, `#`, `$`, brackets, braces, angle brackets, backslash and pipe | `engine/ContextCompressor.kt:283-320` | not reusable for verbatim fields: `~/.ssh/config` becomes `/.ssh/config`, `TS-노트` becomes `타입스크립트-노트` |
| Bridge ignores the `result` event except the session id; exit 0 emits nothing; non-zero exit becomes free text; `tool_use` only updates status; `tool_result` forwards error text only, with no exit code | `claude-cli.ts:149-163,235-255,269-275`; `ws-server.ts:359-370` | no machine facts reach the phone today (§7) |
| The app protocol has no result/summary message; unknown types are dropped | `network/Protocol.kt:17-80`; `MainViewModel.kt:1360-1362` | adapter prerequisite |
| Pure summary code already lives in `engine/` without Android imports (`ContextCompressor.kt`, `OutputClassifier.kt`); `voice/` holds Android playback | grep for `^import android.` | place the composer in `engine/` |
| JVM tests use JUnit 4.13.2 and coroutines-test only; no `unitTests.isReturnDefaultValues` | `app/build.gradle.kts:74-75`; `gradle/libs.versions.toml:13,34`; `test/.../ssh/VoiceCommandRouterTest.kt` | composer must not touch `android.*` or `org.json` (stubbed in unit tests); no new test library |
| No summary-length preference and no "자세히" command exist | grep for `summaryLength`, `짧게`, `자세히` | `length` is a parameter; the detail command is a core dependency |
| None of the §3 type names collide | grep over `android/app/src` | — |

Reuse check: `OutputCategory`, `CompressedOutput` and `ClassificationResult` classify prose by regex and carry no source, so none of them can represent attributed, source-linked facts. One new file is the smallest correct change. No existing file is modified.

## 3. Types (exact signatures; one file `engine/SpokenSummaryComposer.kt`; sole import `java.text.Normalizer`)

```kotlin
package com.voicecode.app.engine

import java.text.Normalizer

// Input: source-linked facts. null = unknown/unobservable; empty list = observed none.
data class SummaryFacts(
    val pendingQuestions: List<PendingQuestion>?,
    val turn: TurnFact?,
    val observedChecks: List<ObservedCheck>?,
    val changes: ChangeFacts?,
    val claim: AgentClaim?,
    val uncertainty: List<UncertaintyItem>?,
    val original: OriginalRef?,
    val quote: AgentQuote?,
)
data class PendingQuestion(val ref: String) // opaque full question key; never parsed or spoken
enum class TurnStatus { COMPLETED, FAILED, CANCELLED, LIMIT, UNKNOWN }
enum class TurnReason { MAX_TURNS, PROVIDER_LIMIT, AUTH }
data class TurnFact(val status: TurnStatus, val ref: String, val exitCode: Int? = null, val reason: TurnReason? = null)
enum class CheckKind { TEST, BUILD, LINT, DEPLOY, OTHER }
enum class CheckStatus { PASSED, FAILED, NOT_RUN, UNKNOWN }
enum class ObservedSource { OBSERVED_TOOL_EXIT, HOST_VERIFIED }
data class ObservedCheck(val kind: CheckKind, val status: CheckStatus, val src: ObservedSource, val ref: String)
data class ReportedCheck(val kind: CheckKind, val status: CheckStatus) // agent_reported by type
enum class ClaimOutcome { SUCCESS, FAILURE, PARTIAL, UNKNOWN }
data class AgentClaim(val outcome: ClaimOutcome, val checks: List<ReportedCheck> = emptyList())
data class ChangeFacts(val files: List<String>, val outOfProject: List<String>, val scopeChanges: List<ScopeChange>)
data class ScopeChange(val action: String, val target: String, val ref: String)
data class UncertaintyItem(val ref: String)
data class OriginalRef(val ref: String, val truncated: Boolean)
data class AgentQuote(val text: String, val parsed: Boolean)
enum class SummaryLength { SHORT, NORMAL }

// Output
enum class SegmentKind { PENDING_QUESTIONS, TURN_STATUS, OBSERVED_CHECKS, SCOPE_CHANGES, AGENT_REPORT, UNCERTAINTY, DETAIL_NOTICE, AGENT_QUOTE }
enum class FactField { PENDING_QUESTIONS, TURN, OBSERVED_CHECKS, CHANGES, CLAIM, UNCERTAINTY }
enum class QuoteSuppression { PARSE_FAILED, TURN_NOT_COMPLETED, PENDING_QUESTION, OBSERVED_FAILURE, SCOPE_CHANGE, CLAIM_NOT_SUCCESS, UNVERIFIED_AGENT_CHECK, RESERVED_LABEL, TOO_LONG, SHORT_PREFERENCE }
data class SpokenSegment(
    val kind: SegmentKind,
    val text: String,
    val mandatory: Boolean,
    val attributedToAgent: Boolean,
    val refs: List<String> = emptyList(), // input refs this sentence reports; never spoken
)
data class SpokenSummary(
    val segments: List<SpokenSegment>,
    val detailRequired: Boolean,
    val omittedCount: Int,
    val unknownFields: Set<FactField>,
    val quoteSuppression: QuoteSuppression?, // null = no quote given, or quote rendered
) {
    val text: String get() = segments.joinToString(" ") { it.text }
}

object SpokenSummaryComposer {
    fun compose(facts: SummaryFacts, length: SummaryLength = SummaryLength.NORMAL): SpokenSummary // body: §4
}
```

Mapping from core §6 (context only; the adapter does the folding): `turn.is_error` is folded into `status`; `turn.src` is not spoken and survives through `ref`; `checks[]` is split into `ObservedCheck` and `ReportedCheck`, so an agent report cannot be typed as an observation; `scope_change{flag,ref}` becomes `ScopeChange(action,target,ref)`. Unsupported or unknown maps to `null`, never to an empty list or a default. `SummaryFacts` has no default values, so every adapter must state each field.

## 4. Rendering rules (exhaustive)

**Rows.** Each row is one segment. Rows are emitted in this order, and `SegmentKind` order is the required spoken order. Refs: R1 question refs · R2 `[turn.ref]` · R3a refs of failed observed checks · R3b refs of the other observed checks it names · R4b scope refs · R6 uncertainty refs · R7 `[original.ref]` when truncated · all other rows empty.

| Row | Kind | Mandatory | Agent-attributed | Emitted when | Text |
|---|---|---|---|---|---|
| R1 | PENDING_QUESTIONS | yes | no | `pendingQuestions` null, or size n > 0 | `대기 질문 확인 안 됨.` / `대기 질문 {n}개.` |
| R2 | TURN_STATUS | yes | no | always | null or UNKNOWN: `턴 상태 확인 안 됨.`; else `턴 완료` / `턴 실패` / `턴 취소됨` / `턴 중단`, then reason (`, 최대 턴 수 도달` / `, 제공자 한도 도달` / `, 인증 오류`; LIMIT without reason `, 한도 도달`), then `, 종료 코드 {c}` when `exitCode` is neither null nor 0, then `.` |
| R3a | OBSERVED_CHECKS | yes | no | `observedChecks` null, or any FAILED | `검사 결과 확인 안 됨.` / `관측된 실패: {kind} {n}건, ….` (FAILED count per kind) |
| R3b | OBSERVED_CHECKS | no | no | kinds with observed checks but no FAILED | `관측된 결과: {kind} {status(aggregate)}, ….` |
| R4a | SCOPE_CHANGES | yes | no | `changes` null, or `outOfProject` size n > 0 | `변경 범위 확인 안 됨.` / `프로젝트 밖 변경 {n}개: {first K paths joined ", "}`, then ` 외 {n-K}개` when n > K, then `.` |
| R4b | SCOPE_CHANGES | yes | no | `scopeChanges` size m > 0 | `요청 범위 밖 작업 {m}개: {action} {target}` of the first item, then ` 외 {m-1}개` when m > 1, then `.` |
| R4c | SCOPE_CHANGES | no | no | `files` size f > 0 | `변경 파일 {f}개.` (names never spoken) |
| R5a | AGENT_REPORT | yes | yes (no for the unknown line) | always | claim null or UNKNOWN: `에이전트 결과 확인 안 됨.`; SUCCESS: `에이전트 보고: 성공{suffix}.`; FAILURE: `에이전트 보고: 실패.`; PARTIAL: `에이전트 보고: 일부 완료.` |
| R5b | AGENT_REPORT | yes | yes | per reported kind, unless it agrees with observation | `{kind} {status(aggregate)} 보고, 관측 없음.` / `{kind} {status(aggregate)} 보고, 관측과 다름.` |
| R6 | UNCERTAINTY | yes | yes | `uncertainty` size u > 0 | `에이전트 보고: 불확실한 점 {u}개.` |
| R7 | DETAIL_NOTICE | yes | no | `detailRequired` | `원문 일부 잘림, ` when truncated, then `요약에서 일부 생략, ` when `omittedCount` > 0, then `자세히에서 확인.` |
| R8 | AGENT_QUOTE | no | yes | quote rules below | `에이전트 요약: {sanitised text}` |

**Words.** Kinds: TEST `테스트` · BUILD `빌드` · LINT `린트` · DEPLOY `배포` · OTHER `기타 검사`. Statuses: PASSED `통과` (`완료` for DEPLOY) · FAILED `실패` · NOT_RUN `미실행` · UNKNOWN `결과 불명`. Kinds are always listed in enum order. Numbers go through Kotlin string templates (locale-independent), never `String.format`. The aggregate per kind is FAILED if any check FAILED, else UNKNOWN if any is UNKNOWN, else NOT_RUN if any is NOT_RUN, else PASSED.

**Claim suffix (SUCCESS only).** A conflict exists when the turn status is FAILED, CANCELLED or LIMIT, or any observed check FAILED; a conflict adds `, 관측과 다름`. Without a conflict, when no `ObservedCheck` has status PASSED (including `observedChecks == null`), the suffix is `, 관측 없음`. Otherwise there is no suffix. Exit 0 therefore only ever produces `턴 완료`, never success.

**Reported check of kind k.** Let o be the observed aggregate of kind k (absent when there is none or `observedChecks` is null). If o is absent or UNKNOWN, the segment ends `관측 없음`. If o equals the reported aggregate, no segment is emitted (agreement, not an omission). Otherwise the segment ends `관측과 다름`. An agent-reported check therefore never becomes a verified check.

**Verbatim fields** (out-of-project paths, scope action, scope target). NFC-normalise. Replace ISO control characters, U+2028–U+2029, U+202A–U+202E and U+2066–U+2069 with a space. Collapse whitespace and trim. Apply no path shortening, abbreviation expansion, character stripping or translation. This is a deliberate exception to the `CLAUDE.md` §4 filename-only rule, limited to these decision-relevant fields. If a field has more than 64 code points, keep the first 64 code points (never split a surrogate pair), `trimEnd`, append ` (이하 생략)` and count one omission. Refs are never spoken, so tool or file text carried in a ref cannot become speech.

**Quote** (always last; the first matching rule wins and is recorded in `quoteSuppression`):
0. `quote == null` or blank text → no segment and `quoteSuppression = null`.
1. `!parsed` → PARSE_FAILED.
2. Turn status other than COMPLETED (including null) → TURN_NOT_COMPLETED.
3. Pending questions non-empty → PENDING_QUESTION.
4. Any observed check FAILED → OBSERVED_FAILURE.
5. Out-of-project paths or scope changes non-empty → SCOPE_CHANGE.
6. Claim not SUCCESS (including null) → CLAIM_NOT_SUCCESS.
7. Any R5b segment emitted → UNVERIFIED_AGENT_CHECK.
8. Sanitised text contains a reserved label → RESERVED_LABEL.
9. Sanitised text longer than 160 code points → TOO_LONG. This counts as an omission, and the text is never truncated, because cutting Korean prose can drop a sentence-final negation.
10. `length == SHORT` → SHORT_PREFERENCE (counts as an omission).
11. Otherwise render the quote.

Sanitising is the verbatim rule without truncation. Reserved labels: `관측`, `에이전트 보고`, `에이전트 요약`, `대기 질문`, `턴 완료`, `턴 실패`, `턴 취소`, `턴 중단`, `턴 상태`, `확인 안 됨`, `프로젝트 밖`, `요청 범위 밖`, `자세히`. Why: quotation marks are inaudible, so prose that imitates the composer's own labels could pass as an observation. The quote comes last, so no system sentence follows agent prose. Null `pendingQuestions` or null `changes` do not suppress the quote, because their unknown sentences were already spoken. A null turn does suppress it (rule 2).

**Bounds and SHORT.** Mandatory rows are never dropped, and every count is complete. Per-list caps (P): out-of-project paths NORMAL 2 / SHORT 1, scope changes 1, check sentences at most 5 kinds, and the quote at most 160 code points and only in the clean case. SHORT also drops R3b and R4c (+1 omission each when they would have been emitted) and the quote (rule 10). `omittedCount` = unspoken out-of-project paths + unspoken scope changes + truncated verbatim strings + a TOO_LONG or SHORT quote + rows dropped by SHORT. `detailRequired = original?.truncated == true || omittedCount > 0`, and R7 is present exactly when `detailRequired` is true. The derived worst case is under 1000 UTF-16 chars (P; FX15 asserts it). No duration or latency claim is made: spoken time depends on the engine and speech rate and has not been measured.

**unknownFields.** PENDING_QUESTIONS (null) · TURN (null or UNKNOWN) · OBSERVED_CHECKS (null) · CHANGES (null) · CLAIM (null or UNKNOWN) · UNCERTAINTY (null; not spoken, because the absence of an agent uncertainty report is not a fact).

## 5. Fixtures (tester-owned `SpokenSummaryComposerTest.kt`, JUnit 4; exact expected text)

Base B = `SummaryFacts(pendingQuestions = emptyList(), turn = TurnFact(COMPLETED, "t", exitCode = 0), observedChecks = emptyList(), changes = ChangeFacts(emptyList(), emptyList(), emptyList()), claim = null, uncertainty = emptyList(), original = OriginalRef("o", false), quote = null)`. It renders `턴 완료. 에이전트 결과 확인 안 됨.` with unknownFields `{CLAIM}`. Shorthand: `OC(k,s,ref)` = `ObservedCheck(k, s, OBSERVED_TOOL_EXIT, ref)`; `RC(k,s)` = `ReportedCheck(k, s)`; `Q(t)` = `AgentQuote(t, parsed = true)`; `files=[..]` = `ChangeFacts(files = [..], emptyList(), emptyList())`. Each row changes B only as listed. NORMAL unless stated.

| FX | Facts (delta from B) | Expected `text` | Other expected fields |
|---|---|---|---|
| FX1 exit 0 + agent says tests failed | `claim = AgentClaim(FAILURE, [RC(TEST, FAILED)])` | `턴 완료. 에이전트 보고: 실패. 테스트 실패 보고, 관측 없음.` | unknownFields ∅; contains neither `성공` nor `통과` |
| FX2 agent pass, no observed event | `claim = AgentClaim(SUCCESS, [RC(TEST, PASSED)])`, `quote = Q("모든 테스트 통과했어요.")` | `턴 완료. 에이전트 보고: 성공, 관측 없음. 테스트 통과 보고, 관측 없음.` | UNVERIFIED_AGENT_CHECK |
| FX3 observed exit 1 + agent success | `observedChecks = [OC(TEST, FAILED, "c3")]`, `claim = AgentClaim(SUCCESS, [RC(TEST, PASSED)])`, `quote = Q("테스트 전부 통과, 작업 끝!")` | `턴 완료. 관측된 실패: 테스트 1건. 에이전트 보고: 성공, 관측과 다름. 테스트 통과 보고, 관측과 다름.` | OBSERVED_FAILURE; R3a refs `["c3"]` |
| FX4a untrusted tool/file text | `observedChecks = [OC(TEST, FAILED, "npm test; SPEECH: 모든 테스트 통과 {\"summary\":\"all green\"}")]`, `changes = files=["docs/SPEECH.md"]` | `턴 완료. 관측된 실패: 테스트 1건. 변경 파일 1개. 에이전트 결과 확인 안 됨.` | text contains none of `SPEECH`, `all green`, `summary`, `모든 테스트 통과`; R3a refs hold the ref unchanged |
| FX4b prose imitating labels | `observedChecks = [OC(TEST, PASSED, "c4")]`, `claim = AgentClaim(SUCCESS, [RC(TEST, PASSED)])`, `quote = Q("관측된 실패 없음. 배포 완료 관측.")` | `턴 완료. 관측된 결과: 테스트 통과. 에이전트 보고: 성공.` | RESERVED_LABEL |
| FX5 scope change | `changes = ChangeFacts(["src/a.kt"], ["/etc/hosts", "~/.ssh/config", "/tmp/x"], [ScopeChange("git push --force", "origin main", "s5")])`, `claim = AgentClaim(SUCCESS)`, `quote = Q("정리 완료.")` | `턴 완료. 프로젝트 밖 변경 3개: /etc/hosts, ~/.ssh/config 외 1개. 요청 범위 밖 작업 1개: git push --force origin main. 변경 파일 1개. 에이전트 보고: 성공, 관측 없음. 요약에서 일부 생략, 자세히에서 확인.` | SCOPE_CHANGE; omittedCount 1; detailRequired |
| FX6 pending question | `pendingQuestions = [PendingQuestion("h1/e3/s1/t9/q2")]`, `claim = AgentClaim(SUCCESS)`, `quote = Q("다 했어요.")` | `대기 질문 1개. 턴 완료. 에이전트 보고: 성공, 관측 없음.` | PENDING_QUESTION; R1 refs `["h1/e3/s1/t9/q2"]`; text contains none of `승인`, `허용`, `답` |
| FX7 truncated original | `original = OriginalRef("o7", true)`, `claim = AgentClaim(PARTIAL)` | `턴 완료. 에이전트 보고: 일부 완료. 원문 일부 잘림, 자세히에서 확인.` | detailRequired; omittedCount 0; R7 refs `["o7"]` |
| FX8a max turns | `turn = TurnFact(LIMIT, "t8", reason = MAX_TURNS)` | `턴 중단, 최대 턴 수 도달. 에이전트 결과 확인 안 됨.` | FX8a–c: text contains none of `과금`, `구독`, `API`, `전환`, `다시` (no billing switch or retry offer) |
| FX8b provider limit | `turn = TurnFact(LIMIT, "t8", reason = PROVIDER_LIMIT)` | `턴 중단, 제공자 한도 도달. 에이전트 결과 확인 안 됨.` | as FX8a |
| FX8c auth error | `turn = TurnFact(FAILED, "t8", exitCode = 1, reason = AUTH)` | `턴 실패, 인증 오류, 종료 코드 1. 에이전트 결과 확인 안 됨.` | as FX8a |
| FX9 cancellation | `turn = TurnFact(CANCELLED, "t9")`, `claim = AgentClaim(SUCCESS)`, `quote = Q("완료!")` | `턴 취소됨. 에이전트 보고: 성공, 관측과 다름.` | TURN_NOT_COMPLETED; text contains none of `사용자`, `멈`, `중지` |
| FX10 unverified deploy | `observedChecks = [OC(BUILD, PASSED, "c10")]`, `claim = AgentClaim(SUCCESS, [RC(DEPLOY, PASSED)])`, `quote = Q("프로덕션 배포 끝났어요.")` | `턴 완료. 관측된 결과: 빌드 통과. 에이전트 보고: 성공. 배포 완료 보고, 관측 없음.` | UNVERIFIED_AGENT_CHECK; `배포` occurs exactly once |
| FX11 malformed optional summary | `quote = AgentQuote("{\"outcome\":\"success\",\"summary\":\"모두 완", parsed = false)` | `턴 완료. 에이전트 결과 확인 안 됨.` | PARSE_FAILED; text contains none of `{`, `success`, `모두 완` |
| FX12 mixed Korean-English paths | `changes = ChangeFacts(emptyList(), ["~/문서/API 설계/TS-노트.md", nfd("../공유/build-로그.txt")], [ScopeChange("rm -rf", "~/바탕화면/old 백업", "s12")])` | `턴 완료. 프로젝트 밖 변경 2개: ~/문서/API 설계/TS-노트.md, ../공유/build-로그.txt. 요청 범위 밖 작업 1개: rm -rf ~/바탕화면/old 백업. 에이전트 결과 확인 안 됨.` | `nfd` = `Normalizer.normalize(s, NFD)` built in the test; expected literal is NFC; text contains neither `타입스크립트` nor `에이피아이` |
| FX13 all unknown (what today's paths can honestly supply) | all eight fields null | `대기 질문 확인 안 됨. 턴 상태 확인 안 됨. 검사 결과 확인 안 됨. 변경 범위 확인 안 됨. 에이전트 결과 확인 안 됨.` | unknownFields = all six; quoteSuppression null |
| FX14 positive control | `observedChecks = [OC(TEST, PASSED, "c14")]`, `changes = files=["src/a.kt", "src/b.kt"]`, `claim = AgentClaim(SUCCESS, [RC(TEST, PASSED)])`, `quote = Q("로그인 폼 검증을 추가했어요.")` | `턴 완료. 관측된 결과: 테스트 통과. 변경 파일 2개. 에이전트 보고: 성공. 에이전트 요약: 로그인 폼 검증을 추가했어요.` | quoteSuppression null; last segment AGENT_QUOTE. SHORT: `턴 완료. 에이전트 보고: 성공. 요약에서 일부 생략, 자세히에서 확인.`, omittedCount 3, SHORT_PREFERENCE |
| FX15 adversarial bound | defined below | contains the listed sentences | NORMAL and SHORT, see below |

FX15 input:
- 40 `PendingQuestion("q$i")`.
- `turn = TurnFact(FAILED, "t15", exitCode = 2)`.
- 300 observed checks with `kind = CheckKind.entries[i % 5]`, `status = if (i % 2 == 0) FAILED else PASSED`, `ref = "c$i"`.
- `changes`: 1000 files `"src/f$i.kt"`; 500 out-of-project paths `"~/외부/" + "가a".repeat(150) + "/$i"`; 50 `ScopeChange("x".repeat(300), "대상".repeat(150), "s$i")`.
- `claim = AgentClaim(SUCCESS, 50 × RC(CheckKind.entries[i % 5], PASSED))`.
- 30 `UncertaintyItem("u$i")`, `original = OriginalRef("o15", true)`, `quote = Q("가".repeat(10_000))`.

For both lengths:
- `text.length <= 1000`.
- `compose(f, L) == compose(f, L)`.
- The text contains `대기 질문 40개.`, `턴 실패, 종료 코드 2.`, `관측된 실패: 테스트 30건, 빌드 30건, 린트 30건, 배포 30건, 기타 검사 30건.`, `프로젝트 밖 변경 500개: `, ` (이하 생략)`, `요청 범위 밖 작업 50개: `, `에이전트 보고: 성공, 관측과 다름.`, `배포 완료 보고, 관측과 다름.`, `에이전트 보고: 불확실한 점 30개.` and `원문 일부 잘림, 요약에서 일부 생략, 자세히에서 확인.`.
- quoteSuppression TURN_NOT_COMPLETED; detailRequired; the last segment is DETAIL_NOTICE.

omittedCount is 551 for NORMAL (498 paths + 49 scope changes + 4 truncations) and 552 for SHORT (499 + 49 + 3 truncations + dropped R4c). SHORT additionally contains `외 499개.` and no `변경 파일`.

**Invariants asserted on every fixture output** (`assertInvariants`):
1. Segment kinds never decrease in enum order.
2. Within a kind, mandatory segments come before non-mandatory ones, and SHORT output contains no non-mandatory segment.
3. With these fixture inputs, `성공` and `통과` occur only in OBSERVED_CHECKS, AGENT_REPORT or AGENT_QUOTE segments; TURN_STATUS never contains `성공`.
4. AGENT_QUOTE, when present, is the last segment and starts with `에이전트 요약: `.
5. `text` equals the segments joined by one space, and every non-quote segment ends with `.`.
6. The text is NFC and contains no ISO control character.
7. DETAIL_NOTICE is present exactly when `detailRequired` is true.
8. Composing the same input twice gives equal results.

**Sufficiency re-evaluation.** Core FX1–FX12 are necessary but not sufficient for this component. FX13 catches unknown facts silently defaulting to a clean result. FX14 catches a composer that never speaks the quote or always hedges, which would otherwise pass every counterexample. FX15 proves boundedness, determinism and SHORT without a time claim. FX8 is split into three variants because each reason renders differently. The composer half of FX4 is covered here (refs are never spoken; label imitation is suppressed). The adapter half ("tool or file text never becomes a quote") cannot be tested at composer level and stays with A5. All fixtures are specified and unrun.

## 6. Handoff (not executed in this phase; order: coder → tester → builder)

- **Coder**: create only `android/app/src/main/java/com/voicecode/app/engine/SpokenSummaryComposer.kt` per §3–§4. Sole import `java.text.Normalizer`: no `android.*`, `org.json`, Gson, coroutines, `Log`, clock, `Locale`, `String.format` or network code. Do not reuse `ContextCompressor` helpers or `TtsSummarizer`. Change no other file and add no call site. Compile with `cd /Users/duckyoungkim/projects/voicecode/android && ./gradlew :app:compileDebugKotlin`. Then run `snyk_code_scan` on the new file and fix/rescan until no new findings remain. Do not run tests or the app. Leave ` D .omc/state/subagent-tracking.json` and `.claude/` untouched, and stage only the named file.
- **Tester**: create only `android/app/src/test/java/com/voicecode/app/engine/SpokenSummaryComposerTest.kt`, using JUnit 4 `org.junit.Test` and `org.junit.Assert` with backtick test names as in `VoiceCommandRouterTest.kt`. Implement FX1–FX15 exactly per §5 plus `assertInvariants`. Run `cd /Users/duckyoungkim/projects/voicecode/android && ./gradlew :app:testDebugUnitTest --tests 'com.voicecode.app.engine.SpokenSummaryComposerTest'`, then the project command `./gradlew test` (`CLAUDE.md:37`) to confirm the three existing test classes still pass. The file may be written from §5 first; it compiles only once the coder's file exists.
- **Builder**: run `cd /Users/duckyoungkim/projects/voicecode/android && ./gradlew assembleDebug` (`CLAUDE.md:33`). No device or app run: nothing calls the composer, so a run cannot exercise it, and no audible behaviour may be claimed.
- Toolchain from source: Gradle wrapper 8.9, AGP 8.7.3, Kotlin 2.0.21, JVM 17. `:app:compileDebugKotlin` and `:app:testDebugUnitTest` are standard AGP task names, not run here (U).

## 7. Unresolved integration prerequisite (not specified or implemented here)

Nothing in the current source produces `SummaryFacts`. Until a structured adapter exists, the composer can only be exercised with synthetic input, and wiring it to today's paths could at best honestly yield FX13. The adapter is core-owned:
- **A1 Turn status.** From the CLI end-of-turn event plus process exit code or signal. Today `result` is ignored and exit 0 is silent (`claude-cli.ts:149-163,269-275`). The event schema is U until fixture capture (core S3).
- **A2 Observed checks.** From each tool call paired with its exit code. Today `tool_use` only updates status and `tool_result` forwards only error text (`claude-cli.ts:235-255`). The command-to-kind rule must be deterministic and host-side (U).
- **A3 Changes.** Changed, out-of-project and scope facts from tool inputs compared with the project root. The scope-class rules are core-owned (U).
- **A4 Pending questions.** Question refs from the question ledger, which does not exist in the source.
- **A5 Claim and quote.** Only from the strict block in the final assistant message; tool output and files are never parsed.
- **A6 Wire message and phone mapping.** Must preserve null versus empty: Gson leaves missing fields null, so they must not be defaulted to `emptyList()`. Today no such message exists (`Protocol.kt:17-80`) and unknown types are dropped (`MainViewModel.kt:1360-1362`).
- **Forbidden substitute:** deriving any fact from `OutputClassifier`/`ContextCompressor` regexes, the screen scrape or `TtsSummarizer` output. That is heuristic truth extraction.
- **Later wiring sketch (not authorized):** on the new message, call `SpokenSummaryComposer.compose(facts, preference)` and make one `voiceEngineManager.speak(summary.text, priority)` call (not one per segment; `TtsManager.kt:95-99`). Priority, interrupt, ledger and readback stay core decisions. The existing `CliOutput` and SSH paths stay untouched until core decides.

## 8. Open items for review (nothing inferred)

1. Approve the types, templates and constants (P: path cap 2/1, 64 code points, quote 160, bound 1000).
2. Questions count-only (recommended: avoids a second, unbound rendering that someone could answer) versus verbatim question text (never options or readback).
3. Verbatim decision-relevant paths versus the `CLAUDE.md` §4 filename-only rule. The project instruction text is not edited in this phase.
4. Quote suppression stricter than core §6 (rules 7–10), and field-specific unknown sentences instead of a single `결과 확인 안 됨`.
5. `engine/` placement (recommended) versus `voice/`.
6. Unmeasured: TTS vocalisation of `/`, `~`, `.` and mixed Korean-English paths, NFD handling and spoken duration. These need device measurement, not this phase.

Unchanged and still unanswered human choices: host placement (phone only or optional own PC), external-cloud audio consent, and hands-free grant scope/duration/limit.
