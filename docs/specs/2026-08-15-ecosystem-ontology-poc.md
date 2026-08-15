# SPEC — 에코시스템 지식 온톨로지 PoC (로컬 전용)

작성 2026-08-15 · 근거: 웹 리서치 5차원 + 각 권고에 대한 반박 라운드(10 에이전트) · **5개 차원 전부 OVERBUILT 판정**

## 왜 하는가 — 가설이 아니라 오늘 실측한 통증

에코시스템 지식은 이미 대규모인데 **조회가 불가능**하다.

| | |
|---|---|
| 태스크 | 850건, 노트 텍스트 317k자 (684건이 노트 보유) |
| dispatch ref | 462건 |
| 규칙 33 · ADR 31 · 리포트 42 · 스펙 19 · 설계 2 | |

그리고 스키마가 **누적(accretion)으로 자란** 상태다. 새로 말할 것이 생길 때마다 모델링 대신 필드나 status 단어를 하나 추가해왔다:

- **status 40종**. `completed`(247) + `done`(234) + `closed`(48) = 같은 뜻 세 단어에 529건이 흩어짐
- status 하나는 **문장 전체**: `"P1-pushed (PR #33 merged 386474b) + P2-done-pending-push (commit 56f0c75) + P3-P6 pending"`
- 하나는 한국어 `보류`
- **키 ~90종**, 대부분 1회만 사용 (`binary_path`, `license_options`, `R5b_pending`, `mvp_deferred_features` …)
- priority가 `P0~P4`와 `high/medium/low` **두 체계 공존**

**이것은 이번 릴리스가 제거한 결함과 같은 계열이다.** `status: "done-pending-release"`는 스키마가 표현하지 못하는 정보를 값 안에 산문으로 밀어넣은 것 — `observation_endpoint_absent`가 401을 담아 나른 것과 같다. enum이라고 주장하지만 실제로는 자유 텍스트다.

## 실제로 답하고 싶은 질문 (Competency Questions)

**CQ는 도구를 열기 전에, 기대 답과 함께 텍스트 파일에 쓴다.** 그리고 **게이트를 통과해야 한다: 단일 SQL 조회나 벡터 검색 하나로 답할 수 있는 CQ는 삭제한다.** 살아남는 것은 멀티홉 질문뿐이다. 3개 미만이 남으면 온톨로지가 필요 없다는 뜻이므로 중단한다.

오늘 실제로 아팠던 질문들 (초안 — 착수 시 게이트 적용):

1. **이 결함 계열이 어디 어디서 나타났는가?** — "인증 실패가 그럴듯한 부재로 퇴화"는 오늘 `dispatch-tracker`, DELETE 경로, `cross-machine`, `cli.js` 2곳, `session-cleanup`, `orchestrator-report-target`, `inject` 종료코드에서 발견됐다. **이 답을 나는 여러 턴에 걸쳐 손으로 조립했다.** 850 태스크·462 ref에 흩어져 있고 지금 구조로는 질의 불가.
2. **이 규칙은 어떤 인시던트에서 나왔고, 이후 어떤 태스크가 그것을 위반했는가?**
3. **이 설계 결정이 어떤 증거에 근거했고, 그 증거가 나중에 반증됐는가?** — 실사례: "tailnet 경로는 안전하다"는 리뷰어 결론이 라이브 `curl` 측정으로 뒤집혔고, 그 정정이 테스트 14b가 됐다.
4. **어떤 태스크가 어떤 커밋으로 닫혔고, 그 커밋은 어떤 테스트로 검증됐는가?**
5. **한 워커의 발견이 다른 워커의 작업 범위를 바꾼 경로는?** — 오늘 최소 4회 발생.

## 스택 — 리서치 반박 라운드가 깎아낸 최종형

```
pip install pyshacl          # rdflib + owlrl을 전이 의존으로 함께 설치. 이것이 의존성 목록 전부.
```

**설치하지 않는 것**: Java, Docker, 트리플스토어 서버, ROBOT, Widoco, Oxigraph(1일차), Protégé(소스 오브 트루스로는), LinkML.

| 결정 | 선택 | 근거 |
|---|---|---|
| 소스 오브 트루스 | **git 안의 `.ttl` 파일** | *"이 결정 하나가 '코너에 몰리지 않기'의 90%"* — GUI 소유 바이너리 블롭 금지 |
| 제약 검증 | **SHACL (pySHACL)** | closed-world. 원하는 대로 동작 |
| 추론 | **OWL 없음 (초기)** | OWL은 open-world라 cardinality 제약이 나쁜 데이터를 거부하지 않고 **새 사실을 추론**한다. CQ가 *파생된* 답을 요구할 때만 추가 |
| 상위 온톨로지 | **BFO/DOLCE 없음** | 정렬해야 할 외부 온톨로지를 **이름으로 지목할 수 없으면** 필요 없다. 잘 문서화된 40 클래스를 나중에 BFO 아래 넣는 건 1주, 엉성한 400개는 영원히 불가 |
| 재사용 | **IRI로 재사용, import 최소** | `dcterms:`, `skos:`, `prov:` (PROV-O는 끝까지 읽을 수 있을 만큼 작다) |
| 쿼리 | **rdflib** (~1M 트리플 미만) | 15~30 트리플 픽스처는 성능 문제가 아니다. Oxigraph는 필요해지면 한 줄 |

## 절차 — 방법론 이름표 없이

반박 라운드의 판정: *"세 개의 명명된 방법론은 이 권고가 진단하는 병 그 자체다."* LOT의 4단계 중 2개(publication, maintenance)는 랩탑 PoC에 존재하지 않는다. Ontology Development 101은 2001년, Protégé-2000용이라 폐기.

**1일차 오전 — 도구를 열지 않는다.** CQ 10~15개 + 각각의 기대 답을 한 파일에. 두 가지 하드 룰(2019 실패 연구 근거): 대명사·플레이스홀더 금지("이 소프트웨어의 유효 입력은?" 형태가 번역 불가로 판명된 바로 그 형태 — SWO의 CQ 88개 중 **46개가 SPARQL로 번역 불가**였다), 그리고 실제 데이터에서 가리킬 수 있는 개체만 지명. 이어서 **모델링하지 않을 것 3~5개**를 적는다. 이 배제 목록이 전체에서 레버리지가 가장 큰 10분이다.

**1일차 오후 — 아직 스키마 없음.** CQ #1의 답이 되는 실제 인스턴스 데이터 ~15~30 트리플을 손으로 Turtle에 쓴다. **답 데이터를 못 쓰면 CQ가 나쁜 것이니 다시 쓴다.** 이것이 "아름다운 스키마인데 맞는 데이터가 없음" 실패에 대한 가장 싼 방어다.

**2일차.** 용어집(용어 → 한 문장 정의, 사용자 언어로). 첫 modelet: **클래스 ≤7, 속성 ≤7**. 모든 용어에 예외 없이 `rdfs:label` + `rdfs:comment`. 온톨로지 + 픽스처를 로드하고 CQ #1을 답하는 SPARQL을 쓰고 **기대 행 수를 assert**한다. 이것이 첫 테스트이고 랩탑에서 밀리초 단위로 돈다.

**3일차 이후 — CQ 클러스터마다 루프.** (1) 새 테스트 케이스 → modelet, (2) 현재 모델에 병합하고 **이전 CQ 쿼리 전부 재실행**, (3) 리팩터(외부 용어 재사용, 어노테이션, CQ가 추론을 요구하는 곳에만 OWL 공리). **(2)의 재실행이 회귀 스위트다.** 이것이 방법론의 전부다.

## 알려진 함정 (리서치가 명시적으로 경고한 것)

- **RDFS 추론은 이 스택에서 저절로 일어나지 않는다.** Oxigraph에는 추론기가 없고(메인테이너 확인), rdflib는 `owlrl`을 추가해 명시적으로 materialize하지 않으면 RDFS entailment를 수행하지 않는다. **2일차 지뢰.** 서브클래스 질의가 조용히 빈 결과를 낼 것이다.
- **에이전트 간 이견 하나 — 평균내지 말 것**: 한 조사자는 `pyshacl --inference rdfs`를 권고했고, 다른 조사자는 그것이 *틀렸다*고 반박했다(SHACL Core의 `sh:targetClass`는 스펙상 이미 `rdf:type/rdfs:subClassOf*`로 정의되므로 "phantom violation" 주장이 성립하지 않는다). **착수 시 직접 실험해서 판정하고 기록할 것.**
- 대규모 사전 CQ 수집 금지 — 조사 대상 엔지니어의 63.5%가 반복적으로 정의하며, 사전 확정 세트는 낡는다.
- ROBOT은 v1.9.10(2025-02) 이후 ~18개월 정체이고 OBO 규약 지향이라, 비-OBO PoC에서는 `robot report`의 모든 항목이 오탐이다. **첫 OWL 공리를 추가하는 날 도입하고 그 전엔 금지.**

## 완료 조건

1. 게이트를 통과한 CQ **≥3개**가 SPARQL로 답변되고, 각각 기대 결과를 assert하는 테스트가 있다
2. CQ #1(결함 계열 추적)이 **오늘 손으로 조립한 그 답**을 재현한다 — 이것이 진짜 수용 기준이다
3. `.ttl`이 git에 있고, `pip install pyshacl` 하나로 재현 가능하며, 회귀 스위트가 한 커맨드로 돈다
4. status 40종 → 정규화된 어휘 매핑이 **데이터로** 존재한다(문서가 아니라)
5. 모델링하지 않기로 한 3~5개가 기록돼 있다

## 명시적 비목표

전체 850 태스크 마이그레이션, 프로덕션 통합, 서버/트리플스토어 운영, 상위 온톨로지 정렬, LLM/GraphRAG 연동. **PoC는 "질의가 가능해지는가"만 답한다.**

## 출처

CQ2SPARQLOWL 데이터셋 (SWO 88개 중 46개 번역 불가): https://www.sciencedirect.com/science/article/pii/S2352340919314544 ·
CQ 사용 실태 조사 n=63 (63.5% 반복적, 84.1% 도구 미사용): https://nemo.inf.ufes.br/wp-content/papercite-data/pdf/use_of_competency_questions_in_ontology_engineering__a_survey_2023.pdf ·
SAMOD: https://github.com/essepuntato/samod · LOT: https://lot.linkeddata.es/ ·
pySHACL: https://github.com/RDFLib/pySHACL · Oxigraph 추론기 부재: https://github.com/oxigraph/oxigraph/discussions/401 ·
ROBOT 릴리스: https://github.com/ontodev/robot/releases
