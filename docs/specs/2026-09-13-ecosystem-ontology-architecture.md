# #1165 생태계 온톨로지: 질문 중심 최소 설계
결속: task1165 | sid eco1165-architect | attempt f6297d46-971b-48f2-9d4f-a6ac6c7ff9f1 | operation eco1165-v1.
상태: 한국어 설계 제안, 2026-09-13. **E=이번 공식 본문 확인, B=지정 기준안의 인계 설명, P=제품 제안, U=설치·성능·권한 경로 미검증**. 아래 제품 구조는 모두 P이며 새 구현 승인이 아니다.

**P 권고:** PC 로컬 exact/어휘 검색을 기본으로 작은 타입 모델을 붙이고, dense+RRF와 관계 탐색은 평가 후 선택한다. JSON-LD/RDF는 선택 교환 형식이다. 필수 triple store·OWL reasoner·외부 플러그인·새 서버 없이 시작한다.
**B 기준 유지:** [경험 설계](/Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-09-13-knowledge-experience-design.md), [온톨로지 방법론](/Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-09-13-knowledge-ontology-methodology.md), [RAG 비교](/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-09-13-rag-methodology-comparison.md)를 보완한다. 내부 소스 서술은 재감사·설치 사실로 승격하지 않는다.

**P 역량 질문(competency questions)으로 범위를 고정한다.** 새 타입/관계는 다음 질문의 미답 사례와 평가 gold가 있을 때만 추가한다.

| 질문·사용 사례 | 필요한 근거·경계 |
| --- | --- |
| Q1 “T1에서 D1을 왜 선택했고 정정 뒤 이유는?” | 작업/결정 원기록 참조, 이유 Assertion, 초기·정정 원문, 정정 효력·이견 |
| Q2 “이 시도에서 M1 어느 버전을 실제 실행했나?” | session+attempt+operation 결속 실행 원기록, MethodVersion, 입력/산출물 참조; 선택 기록만으로 실행 추정 금지 |
| Q3 “지난 시점에는 무엇을 알았고 지금 무엇이 유효한가?” | recorded/observed/valid 시각 분리, 원문 revision과 인간 검토 이력 |
| Q4 “한국어·영어·코드로 같은 방법을 찾고 폰/Buds로 짧게 들어줘” | 언어별 별칭·정확 심볼, 현재 허용 근거 bundle, 검증된 요약/음성 의존성 |
| Q5 “누구의 기록이며 철회하면 연결·집계·재생도 사라지나?” | Person과 principal 구분, occurrence별 동의/ACL/철회 및 역의존 무효화 |

분류체계(taxonomy)는 개념의 계층·이름, 온톨로지는 타입·관계의 의미·제약, 지식 그래프(KG)는 그 모델에 따른 실제 개체·주장, RAG는 찾은 근거를 생성에 제공하는 흐름이다. 서로 대체재가 아니다. SKOS 개념 계층을 OWL 클래스 상속이나 실행 권한으로 해석하지 않는다(E2/E5, RAG 정의는 B).

**E 공식 근거와 P 적용을 분리한다.** 고유 URL 8개 시도, E1–E6 HTTP 200 본문 확인; E7/E8은 각각 최초+2회 재시도 모두 proxy CONNECT 403으로 본문 미확보. 추가 출처 탐색 없음.

| 근거·정확 URL | 확인 범위·발행 상태 | P 적용 및 한계 |
| --- | --- | --- |
| E1 [PROV-O](https://www.w3.org/TR/prov-o/) | W3C Recommendation 2013-04-30; Entity/Activity/Agent, qualified influence, Association/Plan | 출처·수행 역할을 세분화한다. qualified relation은 관계에 설명을 붙이는 패턴이며 인증·인과의 진실 증명이 아니다. |
| E2 [SKOS Reference](https://www.w3.org/TR/skos-reference/) | W3C Recommendation 2009-08-18; ConceptScheme, prefLabel/altLabel, broader | 방법/주제의 한영 명칭·탐색에 한정한다. 언어 태그별 prefLabel 최대 하나; broader를 임의 전이·동일성으로 확대하지 않는다. |
| E3 [DCMI Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/) | 문서 Date Issued 2020-01-20; title, language, identifier, isVersionOf, provenance | 자료 메타데이터와 버전 연결을 재사용한다. dcterms:provenance의 관리·소유 이력 의미만으로 byte anchor·현재 권위 검사를 대신하지 않는다. |
| E4 [SHACL](https://www.w3.org/TR/shacl/) | W3C Recommendation 2017-07-20; RDF shape validation, datatype/cardinality | 내부 필수 필드·참조 구조 검사로 먼저 구현할 수 있다. SHACL 통과는 사실성·인간 승인·인증·ACL 증명이 아니다. 엔진 채택 없음. |
| E5 [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/) | W3C Recommendation 2012-12-11; open world, 개인 동일성 | 미기록≠거짓, 이름 동일/상이≠동일/상이한 사람의 증명. 전체 OWL 추론은 요구하지 않는다. |
| E6 [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) | W3C Recommendation 2020-07-16; JSON 기반 Linked Data, context, RDF 관계 | 버전 고정 context를 포함한 선택 export/import. context 자동 원격 fetch 없이 로컬 고정 매핑; 권위 grant는 교환하지 않는다. |
| E7 [GraphRAG query overview](https://microsoft.github.io/graphrag/query/overview/) | 이번 조회 불가; B에 local=graph+text, global=community map-reduce 설명 | 오픈소스 후보의 질의 방식 비교만 인계. 현재 release/tag/main·라이선스·한국어 성능을 이번에 검증하지 못했다. |
| E8 [BEIR](https://arxiv.org/abs/2104.08663) | 이번 조회 불가; B의 초록 요약은 BM25 기준선 및 reranking 비용 교환 | 어휘 기준선을 비교군으로 유지할 근거로 인계. 최신 모델 평가나 우리 hybrid의 우월성 증거가 아니다. |

E1–E6은 조회일의 공식 문서이며 위 날짜는 발행일이다. 최신 구현 릴리스 확인이 아니다. E1/E2/E4/E5는 페이지의 W3C document-use 고지, E6는 permissive document-license 고지, E3는 CC BY 4.0 고지를 확인했다. 코드 라이선스나 도입 허가는 추정하지 않았다. 원문·응답 헤더·해시·실패 기록은 `.aigentry-report-eco1165/EVIDENCE.md` 및 E1–E6.html에 보존한다.

**P 최소 모듈·소유권:** 다음은 논리 레코드/함수 경계이며 별도 서비스 프레임워크가 아니다.

| 소유자·모듈 | 최소 개체/필드 | 관계·권위 경계 |
| --- | --- | --- |
| aigentry-brain: 지식·검색 | SourceOccurrence(id, consentRef), SourceRevision(id, occurrence, hash, commit), Claim/Assertion, Method(id), MethodVersion(id, method, purpose, conditions, steps?, limits), Concept(id, scheme, labels) | 원문·주장·방법/버전·provenance·knowledge search 소유. revisionOf, versionOf, aboutConcept; 동일 bytes의 다른 occurrence를 합치지 않음 |
| orchestrator: 런타임 참조 | RuntimeRef(authoritySystem, type, stableId, recordRevision), type=Project/Task/Agent/Session/Attempt/Operation/Artifact/Decision/Activity | Task→Project, Attempt→Session, Operation→Attempt/Task, Activity→Operation, Artifact→Activity는 원기록 근거가 있을 때만 투영. 상태 머신·lease·capability 복제 금지 |
| 경계: 식별·검토 | Person(id, scopedNames), PrincipalRef(authAuthority, id), ReviewRef(authoritySystem, id, revision, target, scope, outcome) | Person은 기록 속 사람; principal은 호스트 인증 주체 참조. Agent도 Person과 별개. assertedBy Person/Agent와 authenticatedActor PrincipalRef를 구분; review는 지정 원권위에 조회 |
| VoiceCode: 입출력 | CaptureRef, TranscriptRevision, Summary(id, claimIds, dependencies), AudioPacket(answerId, generation, dependencies, cursor) | 명시 capture·전사·요약·오디오 표시; transcript/summary derivedFrom 원문, 선택 byte↔time mapping. 원본 지식 권위·실행 권위 소유하지 않음 |

실행 결속 키는 `(authoritySystem, session_id, attempt_id, operation_id)`이며 task_id는 문맥이다. 같은 task의 재시도를 합치지 않는다. 경로/PID/이름은 안정 ID나 인증이 아니다. runtime Decision 참조와 “결정했다고 쓰인 Claim”은 별개다.
MethodVersion은 재사용 정의(필요 시 prov:Plan 매핑), Activity는 실제 수행 기록이다. `Decision selects MethodVersion`은 실행 완료가 아니며 `Activity used SourceRevision / generated ArtifactRef / followed MethodVersion`은 각각 근거가 있어야 한다. PROV의 qualifiedAssociation으로 역할/plan을 덧붙여도 성공·실행 권한을 보증하지 않는다.

**P 각 Assertion은 edge 자체의 출처를 가진다.** 노드 하나의 출처를 전체 관계에 전파하지 않는다.

| 필드 묶음 | 최소 계약 |
| --- | --- |
| 내용·범위 | id, schemaVersion, subject, predicate, objectRef 또는 typedLiteral(language?), scope(project/task/source/목적), polarity=positive/negative/unknown |
| 원근거 | evidence[{occurrenceId, revisionId, blobHash, commitRef, byteStart, byteEndExclusive}], assertedBy?, extractedBy/modelVersion?, derivedFromAssertionIds[]; 원본 anchor 필수 |
| 시간 | recordedAt 필수, observedAt?, validFrom?, validTo?; 모름은 null, 시간대 명시, valid 구간은 [from,to). “그때 알았음”과 “그때 유효함”을 따로 필터 |
| 검토·변경 | reviewStatus=unreviewed/accepted/rejected/disputed, reviewRef?, supersedesIds[], conflictsWithIds[], uncertainty[], authority=evidence-only |
| 현재 사용 | consentRefs[], authorityScopeRefs[], dependencyRefs[], lineage/checkpointRefs; 저장 참조는 현재 인증·권위 검사의 입력이며 그 자체가 허가가 아님 |

stored 원문 → 추출된 queryable evidence와 별도 인간 검토를 거친 accepted knowledge를 분리한다. 기계 Assertion은 항상 evidence-only다. accepted 표시는 정확한 원문/Assertion 버전과 현재 유효한 인간 검토 참조가 확인된 투영이며 그래프가 권위를 발급하지 않는다. 미분류 자료도 허용된 원문 어휘 검색을 유지한다.
구조 검사는 타입/필수 출처·reviewRef 조건·참조 폐쇄·시간 순서를 다룬다(E4 응용). byte 범위/해시 검증, 의미적 지지, 주체 인증은 별도 책임이다. 명시 부정과 근거 없음, 충돌을 구분하고 missing=false·confidence=진실 확률·경로=인과를 금지한다.
동명이인과 한영 별칭은 scope별 후보로만 제안한다. fuzzy sameAs 자동 병합·권한 합산 없음. 명시 확인한 identity-link도 출처·유효 범위·가역 병합/분리 이력을 남긴다. SKOS altLabel은 사람의 동일성 증거가 아니다.

**P 구체 예 — 합성 자료, 실제 런타임/개인 데이터 아님.** UTF-8 원문은 아래 backtick 내부 문자열 그대로, 줄바꿈 제외다. 가정: P1/T1, 원권위 R의 D1@r1, 방법 M1/v1, 사람 p1 및 별개 principal u1; 정정 권위는 R에서 인증·확인한다.

| occurrence/revision·commit·시점 | 원문·정확 byte anchor·SHA256 |
| --- | --- |
| S1/r1, c1, recorded=2026-09-01T09:00:00Z | `T1: D1 selects M1/v1 because cost.`; [0,34); `4e1bb4a43db377d5d486b6721f19f111f77eb5e4c8f91c632e261617ec179f3e` |
| S2/r1, c2, recorded=2026-09-03T09:00:00Z | `Correction D1: reason offline, not cost.`; [0,40); `921c557ef03c4c7d0c2f5b507a3e3dbb1481845b35cac7895f13ed87e285da91` |

공통 예시 필드: schemaVersion=1, scope=P1/T1/answer, assertedBy=p1, observedAt=null, consentRefs=[C1], authorityScopeRefs=[R:P1/T1], authority=evidence-only; C1/R/commit은 합성 식별자다. source별 실제 hash/anchor는 위 행을 참조하며 statement마다 evidence를 결속한다.
A0=(D1,selects,M1/v1,positive), A1=(D1,hasRationale,cost,positive)는 S1/r1/c1 전체 anchor 근거, recordedAt=09-01T09:00Z, reviewStatus=unreviewed, validFrom/To=null이다.
A2=(D1,hasRationale,offline,positive), A3=(D1,hasRationale,cost,negative)는 S2/r1/c2 전체 anchor 근거, recordedAt=09-03T09:00Z, validFrom=2026-09-02T00:00:00Z, validTo=null, reviewStatus=accepted, reviewRef=R:review2@r1이다. validFrom과 A2.supersedes=[A1], A3.conflictsWith=[A1]의 효력은 원문에 없는 합성 인간 검토 R:review2가 명시 확인했다는 전제이며 별도 검토 provenance를 붙인다.
실제 수행 예시가 필요하면 R의 session=s1/attempt=a2/operation=o7/Activity=x1 원기록을 추가 조회해야 한다. 위 두 문장만으로 x1·성공·산출물을 생성하지 않는다.
Q1 “T1의 D1 선택 이유를 정정 반영해 알려줘” → 현재 u1/P1/T1/C1 확인 → exact D1@r1 → hasRationale·supersedes·conflictsWith만 최대 2홉/50 edge → A1/S1, A2·A3/S2, R:review2 효력 조회 → 원문 hash/anchor와 현재 권위 재검증 → 근거 bundle.
답변 예: “정정 기록의 이유는 오프라인 접근입니다. 초기 비용 설명은 해당 범위에서 대체됐습니다.”에 S1/S2와 review2를 연결한다. 비용과 오프라인의 일반적 인과는 추론하지 않는다. 검토를 확인 못 하면 “정정 문구는 있으나 효력 확인 불가”로 제한한다.
09-01 당시 지식 질문은 S1만 당시 알려진 것으로, 현재 관점의 09-02 유효성 질문은 나중 기록된 정정을 별도 표시한다. 상충 인간 검토는 양쪽을 가리키는 해소 전까지 함께 유지한다. S2 철회 시 A2/A3와 답변·audio를 출력 전에 무효화하며 A1을 자동 현행 결정으로 부활시키지 않는다.

**P 결정적 검색 라우팅:** 인증된 scope/time을 먼저 고정하고, 관계/정정/시점 패턴이면 exact seed+허용 관계 탐색, 그 외 ID/코드 심볼이면 exact→어휘, 나머지는 어휘+검증된 선택 dense/RRF로 보낸다. 복합 질문의 ID는 seed로 유지한다. 미분류·의도 불명은 같은 scope 어휘 또는 명확화로 끝낸다.
탐색 2홉/50 edge, 최종 근거 10개/4,000 input tokens는 B를 이은 P 예산이다. 정정·충돌·권한 의존성 확인을 budget 때문에 생략하지 않는다. 초과·stale·검증 불가면 부분 답변/보류 또는 검증된 원문으로 강등한다. 생성기 없으면 발췌를 제공한다.
전역 질문도 기본은 허용 범위의 제한 검색/부분 요약이다. 전체 GraphRAG는 반복되는 전체 주제 수요와 평가 이득이 있을 때 별도 후보로 남긴다. 순수 dense는 정확 ID/부정·시간을 보장하지 않으며, 필수 전역 그래프는 군집/요약 갱신·권한별 파생물 비용을 더한다는 설계 판단이다(B/E7/E8 인계, 실측 우열 아님).

**P 개인정보·로컬 경계:** 지속 intake 전 범위 동의를 확인하며 자동 private capture/upload는 없다. 조회·scoring·relation traversal·집계 전에 현재 허용 corpus와 edge 양끝/edge 자체/모든 기여 근거를 검사한다. 전역 점수·숨은 이름·개수·경로를 만든 뒤 필터링하는 방식은 금지한다.
철회/ACL/정정 변경은 원문→Assertion→edge→집계/summary→answer/cache/audio/replay의 역의존을 무효화하고 진행 생성·대기 출력을 취소한다. 재색인 완료를 기다리지 않는다. 모든 원격 egress 및 텍스트/미리보기/export/cache hit/오디오 각 출력·재생 직전 현재 권위를 다시 확인한다. epoch만으로 최신성을 보증하지 않는다.
VoiceCode는 같은 bundle로 짧은 요약→요청 시 출처를 제공한다. 중단·오디오 경로 변경 시 멈추고 자동 스피커 전환하지 않는다. 폰/Buds 지원·STT/TTS 지연은 U이며 구독이 provider API 권한/요금을 포함한다고 암시하지 않는다. 원격은 데이터·목적·목적지 동의 후만, 실패 시 provider 자동 전환 없음.
PC 단일 권위를 우선하며 연결 끊긴 보조 폰은 최신 철회를 확인 못 하면 private cache/audio를 차단한다. 이미 들은 내용 회수는 불가능하다. 향후 서버 이관은 안정 ID·원문/버전/anchor·최신 동의/철회·검토 참조 폐쇄를 보존하고 재검증·재색인하는 별도 범위다.
설정된 coreRoot는 변경하지 않는다. 신규 knowledge/indexes는 strict allowlist root **밖 형제 경로**에 둔다. 전량 replay/blob 검증 비용은 열린 성능 차단점이다. SQLite/FTS5·authority adapter는 B의 제안이며 설치·연결됐다고 하지 않는다. 그래프가 저장소 검증을 우회하거나 런타임 권위를 재구현하지 않는다.
TaskAdvisor 기본 ON/제안만, TaskLoop OFF/명시적 긍정 인간 활성화 전 실행 금지를 유지한다. 지식 그래프의 결정·방법·검토 복사본과 LLM 추론·음성 재생은 capability나 실행 승인이 아니다.

**P 변경·평가 게이트:** brain이 질문/스키마 사전을 소유하고 orchestrator·VoiceCode는 자기 참조 계약을 검토한다. schemaVersion과 extractor/projector/tokenizer/embedding 버전을 분리한다. 의미 변경은 새 버전·mapping·영향 질문·rollback을 기록하고 deprecated 용어는 replacement/sunset을 명시하되 원기록을 보존한다.
추가 필드의 기본은 unknown, Method v2는 과거 v1 수행을 바꾸지 않는다. 별도 파생 projection에서 이전/새 스키마의 참조 폐쇄·정정/철회·답변 차이를 비교 후 전환한다. import/export는 Assertion 단위를 보존하고 무조건적 사실 triple로 평탄화하지 않는다. 미지원 버전은 graph 경로를 멈춘다.
후속 승인 구현에서 원문 계보 분리 한/영/코드 holdout ≥100 answerable+≥40 무근거/모호 질문으로 lexical, hybrid, hybrid+schema, +bounded graph를 같은 생성 budget에서 비교한다. graph는 관계 질문에서 path 방향/타입/시간/각 edge 근거까지 평가한다.
B 수락 목표 유지: eligible recall@10≥90%, support precision/인용 coverage 각각≥95%, 출력 anchor 해상 100%, 충돌 양측 또는 불완전성 표시 100%, ≥50 권한·철회·cache/audio race 사례 무권한 노출 0건. 동명이인 오병합·발명 인과도 채택 차단 사례다. 표본 통과는 보편 보안 보장이 아니다.
graph 승격은 관계 path 완전일치≥95% 및 hybrid+schema 대비 개선 paired 95% 구간 하한>0, 일반 질의 저하 한계 2pp와 유지보수 예산≤30분/100자료를 사전 고정해 판단한다(B 목표). p50/p95 검색·full integrity/ACL·생성·음성, ingest/재색인·메모리·토큰을 분리 계측한다. 근거 부족·비용 초과면 보류한다.
PC 검증 포함 발췌 p95≤1초/첫 생성 text≤3초/8초 deadline, 짧은 음성≤15초/중단 p95≤250ms는 B의 미측정 목표다. Fold7/Buds 기기 수락·서버 이관·현재 권위 wiring·전량 검증 성능 해결 전 전체 목표 완료를 주장하지 않는다.
이번 결과는 설계 문서와 공개 근거만이다. 코드/설치/build/test/benchmark/Git 없음, Snyk N/A(Markdown). 현재 오픈소스 release 확인은 E7/E8 접근 실패로 제한되며 부모 #1165 구현·통합·릴리스는 미완료다.
