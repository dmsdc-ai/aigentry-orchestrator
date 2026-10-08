# #1165 지식 방법론: 작은 온톨로지와 혼합 검색
Binding: task1165 | sid ont1165-architect | attempt b7fd4f03-ee8f-4fb9-93e3-f8dcde06db6f | operation ont1165-v1.
상태: 독립 설계 **제안**, 구현·설치 증거나 새 실행 승인이 아니다. 아래 구조·필드·평가 계획은 모두 제안이다.
기준: `2026-09-13-knowledge-experience-design.md`(지정 baseline) SHA256 `8e0e59de67378ae4e95ce5e62cc62a035f560914c7540f15aada8f41e7dc4fb9` 재확인. 기존 축적·검색·음성 계약을 보완한다.

## 권고와 비교
**작은 질문 중심 온톨로지 + exact/어휘 기본 검색 + 선택 dense 혼합 검색 + 필요한 관계 탐색을 채택한다.** 생성 모델이 있으면 검색 근거로 답하고, 없으면 검증된 원문·결정 필드를 제공한다. 온톨로지가 RAG를 대체하지 않는다.
온톨로지는 개념·관계의 의미와 제약, 지식 그래프는 그 의미로 표현한 실제 개체·주장이다. RAG는 검색한 근거를 생성에 제공하는 방식이고, GraphRAG는 그래프를 검색·요약에 활용하는 방식이다. 서로 같은 제품명이 아니다. [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/), [RAG 원논문 초록](https://arxiv.org/abs/2005.11401).

| 선택지 | 현재 요구에 대한 판단 |
| --- | --- |
| 순수 온톨로지/형식 추론 중심 | 관계·제약 표현은 좋지만 미분류 원문 검색과 자연스러운 답변까지 해결하지 않는다. 매 기록 모델링 부담 때문에 주경로로 부적합. |
| 순수 RAG: 원문 검색·생성만 | 빠른 출발점이나 결정의 유효 시점·동명이인·정정 의존성을 명시적으로 관리하기 어렵다. 기본 검색은 유지하되 이력 모델을 보완한다. |
| 작은 온톨로지 + 혼합 검색 | 필요한 결정/방법 이력만 구조화하고 원문을 항상 검색 가능하게 둔다. 로컬·낮은 입력 부담·정정 추적에 가장 적합하다는 본 설계의 판단. |
| 모든 질의에 전역 GraphRAG 의무화 | 전체 주제 요약에는 후보지만 사전 추출·커뮤니티 요약의 갱신/권한 의존성이 늘어난다. 짧은 작업 질문의 기본값으로 채택하지 않는다. |

[Microsoft GraphRAG 논문 소개](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)는 개체 그래프→커뮤니티 사전 요약→질문별 부분 답변 결합을 설명한다. 해당 전역 질문 평가가 한국어 개인 지식·현재 PC의 이득을 입증하지는 않는다. 작은 관계 탐색에 이 전체 파이프라인을 도입할 필요는 없다.

## 질문으로 정하는 최소 의미 모델
“이 작업은 어느 프로젝트인가?”, “누가 언제 무엇을 결정했나?”, “왜 이 방법을 택했고 무엇이 바뀌었나?”에 필요한 항목만 둔다.

| 개념 | 최소 의미·관계 |
| --- | --- |
| Person | 기록 속 사람의 안정 ID와 문맥별 이름. 로그인 주체/권한과 별개; `assertedBy`의 대상. |
| Project / Task | 질문 범위와 실제 작업. `Task inProject Project`, `Decision about Task`. |
| Source | 동의된 수집 occurrence의 특정 revision·원본 anchor. 같은 bytes도 occurrence별 동의/철회는 별개. |
| Claim / Decision | Claim은 기록된 주장, Decision은 결정이라는 주장 유형. `assertedBy`, `supportedBy Source`, `opposes Claim`, `supersedes Claim`. 인간 검토와 별도로 표현. |
| Method / Procedure | 재사용 가능한 방법의 목적·적용 조건·단계·한계와 버전. 초기에는 하나의 개념으로 두고 절차 단계를 선택 필드로 둔다. `Decision selects Method`, `Decision hasRationale Claim`. |

각 관계는 아래 Assertion의 한 행이다. `selects`는 선택 기록이며 실행 완료가 아니다. 실행 사실이 질문에 필요해질 때 근거 있는 별도 주장으로 추가한다. Method 검색·읽기·인용은 shell/tool capability를 부여하지 않는다.
범용 `causes`, 전역 `sameAs`, 무제한 전이 추론은 초기 모델에 넣지 않는다. 새 개념/관계는 실제 미답 질문과 평가 사례가 있을 때만 추가한다.

## 최소 Assertion 계약과 축적
[PROV-O §3.3](https://www.w3.org/TR/prov-o/#description-qualified-terms)는 관계 자체를 중간 개체로 표현해 추가 설명을 붙이는 패턴을 제공한다. 이를 참고하되 아래 필드는 제품 제안이며 PROV 준수 구현을 주장하지 않는다.

| 필드 묶음 | 제안 의미 |
| --- | --- |
| 식별·내용 | `assertion_id, schema_version, subject_id, predicate, object_id_or_literal, scope, polarity` |
| 출처·생성 | `evidence[{occurrence_id, revision_id, blob_hash, commit_ref, byte_start, byte_end}], asserted_by?, extracted_by/model_version?, derived_from_assertion_ids[]` |
| 시점·변경 | `recorded_at, observed_at?, valid_from?, valid_to?, supersedes_ids[], conflict_ids[]`; 모르는 시각은 null. |
| 검토·불확실성 | `review_state, review_decision_ref?, uncertainty_reasons[], authority=evidence_only`; 인간 결정 권위는 별도 내구성 overlay 참조로 확인. |
| 현재 사용 조건 | `consent_ref, authority_scope_ref, lineage/checkpoint_refs`; 저장된 참조나 confidence는 현재 권한 검사·진실 확률을 대체하지 않음. |

형식 예: `A3={schema_version:1, subject:D1, predicate:hasRationale, object:Coffline, scope:P1/T1, evidence:[S3/r1/bytes[0,108)], asserted_by:p1, recorded_at:2026-09-03, valid_from:2026-09-02, supersedes:[A2], review_state:human_recorded, uncertainty_reasons:[], authority:evidence_only}`. 이 축약 표기의 해시·commit·동의·검토 참조는 실제 저장 시 위 계약대로 필수 결속하며, 예시의 소급 유효일은 인간 정정 범위가 확인됐다는 합성 전제다.
명시적 intake 동의→원문 **stored**→추출 가능 부분 **queryable**→별도 인간 결정 **reviewed**를 유지한다. 기계 Assertion/edge는 evidence-only이며 검토된 정책으로 자동 승격하지 않는다. 추출 실패·불명확 분류도 원문 저장/어휘 검색을 막지 않는다.
사용자는 기록마다 스키마를 작성하지 않는다. 선택 프로젝트·작업과 원문에서 후보를 만들고, 의미에 영향 주는 모호성·상충 결정만 기존 검토 흐름에서 다룬다. 일상적인 허용 수집/검색에는 새 승인 큐를 만들지 않는다. 자동 개인 화면·음성 수집은 없다.

## 한국어 합성 예: 방법, 선택 이유, 정정, 이견
다음 S1–S4는 **실제 개인 자료가 아닌 설명용 정확한 원문**이다. 각각 UTF-8, 따옴표·줄바꿈 제외 전체 문자열이 r1 원본이며 byte 끝은 exclusive다. 해시는 admin EVIDENCE.md에 기록한다.

| Source / 시점 / anchor | 정확한 합성 원문 |
| --- | --- |
| S1/r1, 09-01, bytes[0,78) | 방법 M1: 회의 뒤 결정·이유·반대 근거를 원문에 연결한다. |
| S2/r1, 09-02, bytes[0,73) | 작업 T1에는 M1을 쓴다. 결정 D1의 이유는 비용 절감이다. |
| S3/r1, 09-03, bytes[0,108) | 정정: D1의 이유는 비용이 아니라 오프라인 접근이다. 기존 이유 기록을 대체한다. |
| S4/r1, 09-04, bytes[0,90) | 나는 D1을 비용 절감 결정으로 이해한다. 정정에는 동의하지 않는다. |

예시 문맥은 2026년 P1/T1이며 S1–S3 작성자 p1이 D1 정정 권위를 갖는다는 합성 전제다. S4 작성자 p2의 이견은 별도 기록이다. 실제로는 이름이나 문장만으로 이 권위를 부여할 수 없다.
S1→M1/v1의 방법 설명; S2→`D1 about T1`, `D1 selects M1/v1`, A2=`D1 hasRationale Ccost`; S3→A3 및 A2 대체 기록; S4→A4=`D1 hasRationale Ccost`, `A4 opposes A3`. **각 edge마다** 해당 원문·작성자·시점·검토·불확실성을 붙인다.
“T1에서 왜 M1을 썼지?”는 `T1 ←about D1 →selects M1`로 결정 후보를 찾고, `D1 —A3(hasRationale)→ Coffline`의 edge 근거 S3와 경쟁 edge A2/S2·A4/S4를 회수한다. A는 관계 행 ID이고 edge의 evidence 참조가 원문에 연결되므로 이유·정정·이견을 각각 추적할 수 있다.
답변 예: “9월 3일 정정에는 오프라인 접근 때문이라고 기록돼요. 초기 기록은 비용 절감이었고, 4일 다른 작성자의 이견이 남아 있어요.” 근거 S2–S4를 함께 붙인다. 정정의 효력과 미해결 이견을 구분하며 최신 날짜만으로 A4를 승자로 정하지 않는다.
과거 시점 질문에는 그때 기록된 S2와 나중 정정 S3를 구분한다. S2에 이유가 없었다면 M1·T1의 연결이나 다른 프로젝트의 비용 기록으로 이유를 발명할 수 없다. 그래프 경로는 근거를 찾으며 기록되지 않은 인과를 증명하지 않는다.

## 동일성·진실·변경 관리
동명이인은 scope+안정 ID로 구분한다. 다른 프로젝트의 “민수”는 자동 연결하지 않고 문맥별 후보로 둔다. 임베딩 유사도는 후보 제안만 하며 자동 병합 금지; 필요한 경우 질문 한 번 또는 기존 명시적 정정으로 identity-link를 기록한다. 병합/분리도 출처 있는 가역 이력이며 권한을 합치지 않는다.
[OWL Primer의 open-world 설명](https://www.w3.org/TR/owl2-primer/)처럼 미기록은 거짓이 아니다. 이름이 다르다고 다른 사람, 같다고 같은 사람이라는 형식 보장도 없다. 본 모델은 불명/명시 부정/상충을 구분하며 전체 OWL reasoner 채택을 요구하지 않는다.
[SHACL](https://www.w3.org/TR/shacl/)은 RDF 그래프의 shape 제약 검증 언어다. 출처 누락·필드 형식·참조 위반을 검사하는 접근은 유용하지만 통과가 현실의 진실·인간 승인·ACL 유효성을 증명하지 않는다. 초기 논리 레코드에 필요한 검증만 설계하며 SHACL 엔진 의존성은 결정하지 않는다.
원문 revision, Method version, Assertion 정정은 append-only; Method v2가 v1 적용 결정을 소급 변경하지 않는다. `supersedes`는 정정 대상·범위·유효 시간·인간 권위를 확인할 때만 현재 projection에 반영한다. 상충 인간 결정은 양쪽을 참조한 scoped 해소 전까지 함께 표시한다.
스키마는 `ontology_schema_version`과 extractor/projector 버전을 구분한다. 추가 필드는 기본 미상으로 호환; 관계 의미 변경은 새 버전과 명시적 mapping을 사용한다. 소유자는 #1165이며 의미 변경 검토에는 실제 질문·기존 주장 영향·rollback 계획을 첨부한다.
이전 원본·Assertion을 보존하고 외부 파생 저장소에서 새 projection을 재구축해 참조 폐쇄·정정·철회·답변 차이를 확인한 후 전환한다. migration은 과거 검토를 새 의미의 승인으로 바꾸지 않는다. 지원하지 못하는 버전은 해당 graph 경로를 중단하고 허용된 원문 조회로 낮춘다.

## 검색·권한·로컬/서버 경계
기준 KnowledgeService 계약에서 현재 권위 확인→허용 scope의 exact/어휘→선택 dense/RRF를 수행한다. 특정 결정·출처는 exact, 관계·변경 질문만 작은 graph 확장을 사용한다. 초기 실험 한도는 2 hops/50 edges로 제안하며 초과·불명 의도는 무확장 검색 또는 명확화로 끝낸다.
충돌·정정 의존성 검사는 탐색 budget과 별개다. 알려진 반대 근거를 자르거나 미적용 정정을 숨기지 않고, 필요한 의존성을 확인 못 하면 부분 답변/보류한다. 전역 주제 요약은 명시적 전체 범위 질문에서만 별도 평가 후보로 남긴다.
그래프/색인은 coreRoot **밖** 재구축 가능한 논리 테이블·edge 계층이다. 기존 strict root allowlist와 전량 검증 비용을 유지한다. RDF triple-store·Neo4j·서버·새 라이브러리를 필수화하지 않으며 기준 FTS5 제안도 driver/플랫폼 검증 전 설치 사실이 아니다. graph가 기존 검증 지연을 없애지 않는다.
모든 edge·요약·답변·음성은 기여 원본/revision/Assertion/정정 의존성을 보존한다. 정정·철회 commit 시 역의존 projection/cache/요약을 무효화하고 생성·대기 음성을 취소한다. 색인 재구축 완료를 기다려 접근 차단하지 않는다.
검색·scoring 전, 원격 전송 전, 모든 출력·미리보기·재생 직전에 현재 인증/동의/철회를 확인한다. node와 edge 양끝 이름도 보호하며 캐시 epoch만으로 통과시키지 않는다. 오래된 음성은 재생성; 이미 들은 내용은 회수할 수 없다. 최신 권위 불명인 오프라인 보조 기기는 private 재생 차단.
원격 STT/embedding/reranker/LLM/TTS는 데이터·목적·목적지 범위가 명시적으로 허용된 경우만 사용한다. 다양한 LLM·VoiceCode 어댑터가 같은 근거 계약을 공유하며, 미지원 모델/음성 엔진에는 검증된 텍스트 발췌 경로를 유지한다.
PC를 현재 단일 로컬 권위로 두고 이후 서버 이관은 논리 ID·버전·원문 anchor·동의·최신 철회·정정의 참조 폐쇄를 보존해 재색인한다. 경로·PID·실행 grant는 이관 권위가 아니다. 서버 전환·키 복구는 기준의 별도 범위이며 실제 지원은 미검증이다.
TaskAdvisor ON/제안만, TaskLoop OFF/명시적 긍정 인간 활성화 전 실행 없음. 저장된 승인문·검색된 절차·음성 재생은 현재 실행 허가가 아니다.

## 측정 후 채택
향후 승인된 구현 범위에서 기준의 한국어/영어 합성 holdout과 같은 생성 budget으로 어휘-only, 선택 dense 혼합, 작은 ontology+관계 탐색을 비교한다. 관계/과거시점/정정 질문을 별도 집계하고 동명이인·부정·무근거 인과·철회·오프라인 재생 사례를 포함한다.
eligible evidence recall@10, 주장 support precision·인용 coverage, 상충 누락·잘못된 병합·정정 반영, 사용자 명확화/수동 작업 수, p50/p95 전체 지연·저장/갱신/재구축 비용·메모리·토큰을 함께 잰다. 검색과 전량 integrity/auth 비용을 분리 계측한다.
기준 수락 목표를 유지하고 paired 차이와 불확실성을 보고한다. 관계 질문의 근거 회수 개선이 확인되고 기본 질의/사용자 부담/비용이 수용 가능할 때만 확장을 켠다. 권한 누출·근거 없는 자동 병합·철회 후 출력 관측은 채택 차단 조건; 일반 검색 개선으로 상쇄하지 않는다.
전역 GraphRAG는 실제 전체 주제 질문의 미충족 수요가 확인된 때만 별도 비교하며 기본 릴리스 선행조건이 아니다. PC/Fold7/Buds2Pro 지연·지원성은 미측정, 보편적 최적성·100% 정확성 주장은 없다.
공식 근거 5종은 2026-09-13 직접 조회·관련 본문 검토. 최초 5회 중 W3C 3건 실패 후 승인된 3회 복구 모두 완료; 한계·해시는 `.aigentry-report-ont1165/EVIDENCE.md`에 보존한다. 기존 focused 97pass/0fail/1envskip은 전달된 저장 slice 결과일 뿐 새 검증이 아니다. 제품 구현·build/test·Snyk 대상 코드 변경 없음; 기존 release 작업과 구현 검증은 미완료다.
