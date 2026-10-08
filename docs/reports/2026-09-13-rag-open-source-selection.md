# #1165 현재 오픈소스 RAG 선택 — 로컬 우선 설계 제안
결속: task1165 | sid oss1165-researcher | attempt c4ad9256-e966-4bb6-a443-b2d3bba3e10d | operation oss1165-v1.
**권고: 자체 KnowledgeService + exact/어휘 fallback을 기본으로 유지하고, SQLite FTS5를 첫 선택 색인으로 검증한다. Dense가 실제로 필요하면 sqlite-vec부터 비교하고, 서버 규모에서 Qdrant를 검토한다. 필수 RAG 프레임워크·Python·Docker·graphDB는 추가하지 않는다.** 이는 통합 부담과 로컬 가용성에 따른 설계 판단이며 보편적 속도·품질 1위 주장이 아니다.
공식 원문 16개를 2026-09-13 직접 HTTP 200으로 확보했다. E번호는 아래 정확 URL과 admin 증거에 대응한다. 기능 설명은 upstream 주장, 선택·게이트는 제안, 제품 지원·성능은 미측정이다.

| 주 후보 7개 / 범주 | 기능과 설치·호출 경계 | 부담·오프라인·OS / 채택 판단 |
| --- | --- | --- |
| 1. LlamaIndex Python/TS / 임베디드 프레임워크 | Python `llama-index-core` + 필요한 integration 패키지; retriever/query/rerank 모듈. TS `llamaindex` + provider 패키지는 별도 구현(E01/E08). | Python 런타임·어댑터·모델 자산 필요. Python README는 회사 중심이 parsing/extraction으로 이동했다고 설명. **TS는 2026-04-30 archive, deprecated/유지보수 종료**: 신규 Node 기본 채택 제외. Python 기능을 TS에 전이하지 않음. |
| 2. Haystack / Python 프레임워크 | `haystack-ai`; 검색·ranking·routing·평가 component/pipeline. HTTP 제공은 별도 Hayhooks 경계(E02). | Python 서비스/프로세스와 자체 orchestrator의 역할 중복. 복잡한 파이프라인이 필요할 때 Python 비교군으로 우선. 로컬 모델 구성·telemetry 비활성 검증 필요; OS별 패키징 미검증. |
| 3. RAGFlow / 전체 플랫폼 | 문서 파싱·chunk 검토·citation·다중 recall/fused rerank·API. Docker Compose 및 ES/MinIO/Redis/MySQL 서비스 구성(E03). | README 최소 4 cores/16 GB/50 GB, 제공 이미지는 x86이고 ARM64 자체 빌드 안내. slim 이미지에는 모델 별도. PC 필수 스택에는 과다; 문서 운영 UI 수요가 큰 별도 서버 후보. |
| 4. Dify / 전체 플랫폼 | Compose 배포, workflow/RAG/모델 관리·LLMOps·API. 자체 UI/워크플로와 중복(E04). | README 최소 2 cores/4 GiB는 aigentry 실제 footprint가 아님. 모델·플러그인 준비와 egress 통제가 있어야 오프라인 검증 가능. **추가 라이선스 조건 때문에 기본 재배포·멀티테넌트 서버 후보 제외**(E15). |
| 5. Qdrant / 검색 저장 서비스 | `qdrant/qdrant` 컨테이너 또는 서버 배포물 + REST/gRPC; 공식 JS/TS client는 선택. dense/sparse/multivector, RRF/DBSF, payload 필터, sharding/replication·metrics(E05). | 서버 운영·인증·백업 경계 추가. 한국어 sparse 생성과 reranker/답변 평가는 별도. 서버 승격 1순위; 기본 PC에는 불필요. README의 Edge는 Python/Rust 프로세스 내 대안이며 Node 내장 동등성·별도 배포 라이선스 미확인. |
| 6. LanceDB / 임베디드 저장 라이브러리 | 로컬 Lance 저장 + Python/Node/Rust SDK; vector·FTS·SQL·버전 관리(E06). | daemon 없는 dense 중심 비교군. native 배포물·SDK별 hybrid/rerank/필터 동작·OS 지원 조합을 검증해야 함. OSS 로컬 SDK와 Cloud/Enterprise REST 운영 기능을 동일시하지 않음. |
| 7. SQLite FTS5 + 선택 sqlite-vec / 임베디드 색인 | FTS5는 SQLite 기능, `sqlite-vec`는 별도 C 확장/npm 패키지. SQL 어휘·BM25 + 선택 vector 결과를 자체 RRF로 융합(E07/E12). | 가장 작은 목표 구성이라는 판단. 현재 Node >=20 선언만 있고 **SQLite 의존성은 없음**(baseline 인계). driver/FTS 빌드·extension loading·native OS 패키징 미검증; 실패 시 기존 bounded lexical. vec는 pre-v1 변경 위험. |

SQLite core의 public domain과 외부 driver/확장의 라이선스는 별개다(E16). 아래 MIT/Apache 표기는 저장소의 공식 README/라이선스 표식 확인이며, 릴리스 배포물 전체·전이 의존성·모델 라이선스 감사 완료를 뜻하지 않는다.
Dify는 순수 Apache-2.0이 아니다. main LICENSE는 서면 허가 없는 multi-tenant 운영(tenant=workspace)과 frontend 로고/저작권 변경에 추가 조건을 두며 해당 경우 상업 라이선스를 요구한다. frontend를 사용하지 않는 경우의 해당 branding 예외도 명시한다(E15). 법률 적합성 판정이나 면제 취득은 이번 범위가 아니다.

작은 PC 구성과 서버 전환 경계는 다음과 같다. 모든 패키지명은 설치 사실이 아니라 후보 경계다.
1. aigentry가 배포하는 동일 프로세스의 KnowledgeService가 인증·현재 권위·검색·인용·출력 admission을 담당한다. FTS5 driver 선택 전에는 별도 설치 없는 exact/어휘 발췌를 유지한다. 생성기 없이도 검색이 완결되어야 한다.
2. FTS5 채택은 지원 SQLite/driver 조합을 고정해 aigentry 설치물로 제공할 수 있을 때만 한다. Node 20에서 builtin을 가정하거나 `sqlite-vec`가 SQLite driver까지 제공한다고 해석하지 않는다. 모델은 선택 다운로드·라이선스/용량 표시 후 로컬 준비하며 자동 원격 전환은 없다.
3. 문서 변환이 필요할 때만 `docling` Python 패키지를 격리된 로컬 ingestion worker로 검토한다(E11). CLI/API 서버는 선택 경계이며 필수 daemon이 아니다. OCR/표/읽기 순서 결과와 원본 byte/page map의 정확성은 별도 검증; 실패한 추출을 정본으로 덮어쓰지 않는다.
4. 서버 이관 초기에는 같은 논리 계약과 단일 writer를 유지한다. 동시 질의·vector 크기가 로컬 색인의 측정 한계를 넘을 때 Qdrant를 **파생 검색 서비스**로 추가한다. aigentry API만 클라이언트에 열고 검색 저장소가 실행/승인 권위를 갖지 않게 한다. Qdrant 사용만으로 서버 이관이 끝나지 않는다.
5. 논리 ID·원본/revision·hash·동의·정정·최신 철회·권위 checkpoint를 일관된 manifest로 보존하고 destination identity를 재검증한 뒤 재색인·명시적 cutover한다. 원본 유지와 rollback 검증이 필요하며 이번에는 전송/서버 생성하지 않았다.

기존에 설정된 **coreRoot는 그대로 유지**한다. 신규 `knowledge/` 권위 overlay와 `indexes/` 파생물은 strict allowlist coreRoot 밖의 별도 sibling 경로로 구성한다. 기존 root를 자동 wrapping/이동하지 않는다. AuthorityReadModel·batch snapshot/tail API는 baseline 제안이지 설치된 adapter가 아니다.
원본 전량 replay/blobvalidation 비용은 여전히 성능 blocker다. 색인이 빨라도 이 비용을 생략할 권한은 없다. text/FTS/meta/applied sequence는 같은 파생 transaction에 묶고 검증된 연속 commit만 적용한다; 재구축 완료 전에 현재 철회 gate가 먼저 노출을 막는다.
한국어 조사·띄어쓰기/영문 별칭/코드 심볼·대소문자·기호는 별도 평가한다. FTS5 unicode61은 한국어 형태소 분석기가 아니며 trigram은 3자 미만 MATCH 제약이 있다(E07). exact ID·심볼 경로를 보존하고 정규화 본문과 원본 UTF-8 `[byte_start,byte_end)`를 분리한다.

인터넷 온톨로지 관행의 적용도 작은 계약으로 제한한다. PROV-O의 qualified relation/derivation/revision 패턴은 **관계마다 출처·생성자·시점**을 붙이는 근거다(E13). SKOS의 언어별 preferred/alternative label은 한국어·영어 용어 alias에 적용하되 인물 동일성이나 사실 진실을 선언하는 용도로 쓰지 않는다(E14).
질문에 필요한 Person/Project/Task/Source/Claim/Decision/Method만 시작하고 `supportedBy/opposes/supersedes/selects/hasRationale`를 명시한다. assertion에는 scope, occurrence/revision/hash/commit/byte anchor, recorded/valid time, extractor/schema 버전, review 참조와 역의존성을 둔다. 일반 관계 경로로 인과를 추론하거나 같은 이름을 자동 병합하지 않는다.
**stored → queryable evidence → accepted knowledge**는 다른 상태다. 기계 assertion·edge·요약은 evidence-only; 현재 인간 결정 권위 없이 승격하지 않는다. 원본/정정은 append-only이며 상충 인간 결정은 scoped 해소 전 양쪽을 보인다. 새 ontology 버전으로 재투영해도 과거 승인이 새 의미를 승인하지 않는다.
메타데이터 필터는 종단 권한 안전성의 증거가 아니다. 검색/scoring 전의 허용 corpus, 모든 외부 STT/embedding/reranker/LLM/TTS 전송, text/preview/export/cache/context/audio/replay 출력 직전마다 현재 인증·동의·ACL·철회를 확인한다. node/edge 이름과 집계·요약도 전체 기여 provenance가 필요하다.
정정·철회는 occurrence/revision 의존 chunk→edge→summary→answer/cache/audio를 무효화하고 진행 중 생성·대기 출력을 취소한다. 같은 bytes의 다른 occurrence 동의를 합치지 않는다. 최신 권위 불명인 오프라인 phone/server는 private 캐시·재생을 차단한다. 이미 들은 음성을 회수했다고 주장하지 않는다.
동의 전 지속 intake·개인 화면/주변음 자동 수집·업로드 금지, silent provider switch 금지를 유지한다. TaskAdvisor 기본 ON/제안만, TaskLoop OFF/명시적 긍정 인간 활성화 전 실행 금지. 원래 task runtime이 권위이며 복사 승인문·검색 결과·LLM 추론·그래프 결정은 capability가 아니다.
PC 질문→검증된 짧은 답/인용→VoiceCode presentation→phone/Buds의 동일 계약을 제안한다. 원격 STT/TTS는 허용된 목적·대상만 사용하고 엔진 부재 시 텍스트 발췌로 낮춘다. 기기 연결/오디오 route 변경 시 멈추고 재생도 재검증한다. Fold7/Buds2Pro 지원·끊김 없는 경험은 아직 미측정이다.

보류 대안: LightRAG는 MIT Python SDK `lightrag-hku`, API/UI는 `[api]` 추가 경계다. README는 graph+vector, reranker, 평가/trace 연동과 삭제 후 그래프 갱신을 설명하지만 그것이 aigentry 철회·anchor 완전성을 입증하지 않는다(E09). 관계 질문 수요가 입증되면 작은 명시 graph와 비교한다.
Microsoft GraphRAG는 MIT 연구 파이프라인이고 main에서 maintenance mode, 신규 기능/PR 미수용, 필요 시 버그/의존성 갱신을 공지한다. indexing 비용과 버전 변경을 경고하므로 전역 주제 질문이 반복될 때만 연구 비교군이다(E10). 어떤 GraphRAG benchmark도 여기서 실행하거나 우리 성능으로 전이하지 않았다.
LangChain은 자체 orchestrator보다 추가 가치가 특정되지 않아 이번 채택·독립 조사에서 제외했다. Docling은 ingestion 도구이며 RAG 플랫폼 대체재가 아니다. Qdrant Edge는 README의 존재만 확인했으며 추가 SDK 문서/라이선스 조회는 16개 상한 때문에 하지 않았다.

| 후속 승인된 실험 게이트 — 이번 실행 없음 | 정확한 판정·관측 |
| --- | --- |
| G0 배포·라이선스 | macOS arm64/x64, Windows x64, Linux x64의 지원 대상/Node floor 확정; SQLite driver/FTS5/WAL·vec native loading·중단 복구 검증. 각 선택 배포 tag/발행시각/해시·LICENSE/NOTICE·모델/전이 의존성 고정. 실패 조합은 lexical fallback, TS deprecated 채택 제외. |
| G1 공통 품질/권한 | 계보 분리 합성 한/영/코드 holdout ≥100(라우팅 4군 각 ≥25), 무근거/모호 ≥40; eligible recall@10 ≥90%, support precision/인용 coverage 각각 ≥95%, 출력 anchor 해상 100%. ≥30 정정 fixture의 유효 정정/상충 표시 100%, ≥50 ACL/철회/cache/audio race에서 무권한 byte 0; 한 건도 승격 차단. |
| G2 선택 검색 개선 | exact+어휘 → FTS5 → dense+RRF → reranker를 동일 gold/생성 budget으로 ablation. 어휘/dense 각 30→합집합 ≤60→근거10/입력4,000/출력400 tokens. paired 95% 구간·언어/질문군 결과와 사전 비열등 한계 2pp 보고; 품질 headroom 이득 또는 동등 품질의 비용/지연 개선 없으면 보류. |
| G3 비용/관측 | 100/1k/10k occurrence의 cold/warm p50/p95 검색, integrity/ACL, ingestion/reindex, RSS/디스크·토큰을 분리. 검증 포함 발췌 p95 ≤1초, 첫 검증 생성 text ≤3초, 8초 deadline 목표. 전체 replay 비용 미해결이면 검색-only 성공으로 통과시키지 않음. |
| G4 graph/서버/음성 | graph 2홉/50edge, 관계 path 일치 ≥95%, hybrid+schema 대비 개선 구간 하한 >0, 관리 ≤30분/100자료 제안. 전역군은 근거 있는 주제 coverage 개선과 G1/G3 필요. 서버는 동시 부하·복구/cutover·최신 철회 검증 후. 실제 기기 ≥30 session, 첫 짧은 음성 길이 ≤15초·중단 p95 ≤250ms·route 변경 누출0 목표. |

관측은 로컬 request ID·단계 지연·adapter/version·rank·색인 lag/coverage·인용 검증·취소 결과만 기본 기록하고 raw 질의/근거/음성 로그는 별도 동의다. 프레임워크의 evaluation/LLMOps, store의 metrics는 인간 gold와 end-to-end trace를 대체하지 않는다. 외부 trace 전송도 egress gate 대상이다.

| 근거 / 정확한 1차 URL | 2026-09-13 확인한 라이선스·유지보수/릴리스 한계 |
| --- | --- |
| E01 https://github.com/run-llama/llama_index | MIT 표식; main Python README의 사업/개발 중심 이동 공지. 최신 배포 tag/발행일 미확인. |
| E02 https://github.com/deepset-ai/haystack | Apache-2.0 표식(추가 License 표식 존재); main README의 3.0 출시 공지 확인, 실제 tag/발행일 미확인. |
| E03 https://github.com/infiniflow/ragflow | Apache-2.0 표식; README 최근 소식 2026-06-15, 설치 예시 v0.27.2. 예시를 최신 release로 간주하지 않음. |
| E04 https://github.com/langgenius/dify | Dify Open Source License 표식; main 기능 설명, 최신 배포 tag/발행일 미확인. 조건 원문 E15. |
| E05 https://github.com/qdrant/qdrant | Apache-2.0 명시; 조회 기본 branch master, 개발 branch dev 안내. server/Edge 배포별 최신 tag·동등성 미확인. |
| E06 https://github.com/lancedb/lancedb | Apache-2.0 표식; main OSS/Cloud/Enterprise 구분, 최신 SDK별 tag/발행일 미확인. |
| E07 https://www.sqlite.org/fts5.html | FTS5/BM25/tokenizer/external-content 공식 문서; 특정 SQLite 배포 버전 증거 아님. |
| E08 https://github.com/run-llama/LlamaIndexTS | MIT 표식, archive 2026-04-30 직접 확인; main deprecated/유지보수 종료. Node >=20 설명은 과거 호환 주장. |
| E09 https://github.com/HKUDS/LightRAG | MIT 표식; main 소식 2026-07, API/SDK 설명. 최신 배포 tag/발행일 미확인. |
| E10 https://github.com/microsoft/graphrag | MIT 표식; main maintenance 공지 직접 확인, 공지 발행일·최신 배포 tag는 미확인. |
| E11 https://github.com/docling-project/docling | 코드 MIT/모델별 별도 라이선스 명시; main Python ≥3.10, 2.70.0부터 3.9 중단 설명. 최신 버전은 미확인. |
| E12 https://github.com/asg017/sqlite-vec | MIT/Apache-2.0 두 표식; pre-v1 경고. 선택 배포물의 적용 범위·최신 tag/발행일 미확인. |
| E13 https://www.w3.org/TR/prov-o/ | W3C PROV-O Recommendation 2013-04-30; qualified provenance 패턴, 제품 권한 안전성 보장 아님. |
| E14 https://www.w3.org/TR/skos-reference/ | W3C SKOS Recommendation 2009-08-18; 언어별 label/용어 체계, 사실·인물 동일성 판정 아님. |
| E15 https://raw.githubusercontent.com/langgenius/dify/main/LICENSE | custom 조건 본문 직접 확인; main이며 released LICENSE와 동일하다는 검증 없음. |
| E16 https://www.sqlite.org/copyright.html | SQLite 코드/문서 public domain 명시; 외부 driver·extension까지 포괄하지 않음. |

16개 고유 문서 상한을 모두 사용했다. web transport 실패 뒤 지정 curl 방식으로 같은 범위의 공개 원문을 확보했으며 추가 링크/registry/releases 페이지는 수집하지 않았다. GitHub Releases 영역은 tag/발행시각을 반환하지 않아 최신 릴리스·최근 커밋 날짜/빈도·전체 license file 검증에는 명시적 한계가 있다. main/master의 기능을 이미 배포된 기능으로 단정하지 않는다.
admin `.aigentry-report-oss1165/`에 원문·관련 본문·URL/확보시각/SHA256/HTML의 branch OID를 보존했다. OID는 공개 HTML 관측이며 Git 측정이 아니다. 직접 인용 없이 요약했고 stars/벤치마크 홍보 수치는 선정 근거에서 제외했다.
기준 3문서: `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-09-13-knowledge-experience-design.md`, `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-09-13-knowledge-ontology-methodology.md`, `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-09-13-rag-methodology-comparison.md`. 기존 런타임 서술은 인계 정보이고 이번 소스 감사/설치 확인이 아니다.
controller base `6f515931c0d1967ffbe8eb0464a96292030a1f6d`는 전달값; Git/현재 main/clean 확인 없음. 제품 코드·설치·build·test·benchmark·서버·개인 자료 전송 없음, Markdown-only Snyk N/A. 연구 산출물만 완료하며 parent #1165의 구현·권위/성능·음성·서버/출시 검증은 미완료, 새 구현 승인 아님.
