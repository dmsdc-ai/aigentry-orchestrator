# aigentry 수익화 시장 리서치 — 가설 검증 (tq#594)

- **작성**: researcher 세션 `mkt-research-v1` (dustcraw 역할, Fable 5) — 2026-06-10
- **방법**: deep-research 워크플로우(5개 검색 각도, 24개 출처 fetch, 113개 claim 추출, 상위 25개 3-표 적대 검증 → 17 확정/8 기각) + 갭필 병렬 리서치 에이전트 4기(경쟁사 가격, 메모리 로드맵, 오케스트레이션 수익화, 브리지/local-first). 모든 수치에 출처 URL + 날짜 병기. 추정/미검증은 명시.
- **역할 준수**: 수집·종합만. 결정 없음. 코드 없음. "시사점"은 수집 데이터가 가리키는 방향이며 결정은 orchestrator 몫.

---

## 요약 (TL;DR)

1. **Q1 (registry — 에이전트 신뢰/평가/감사)**: 시장은 실재하며 초고성장(벤더 합산 CAGR 20~45%). TAM 점추정은 벤더별 4~6배 발산($0.9B~$15.8B 2029/2030)이므로 점수치가 아닌 성장률 밴드를 신뢰할 것. UK 정부(DSIT)가 "중립 3자 AI 보증" 시장을 공식 로드맵으로 인정(£1.01B→조건부 £18.8B/2035). 단 EU AI Act 고위험 의무는 Digital Omnibus로 2027-12/2028-08로 16~24개월 연기 — 컴플라이언스 수요 본파도는 2027~28년. 기존 eval/observability 9개사 중 **누구도 중립 3자 신뢰 레이어로 포지셔닝하지 않음**(유일한 직접 플레이어는 AIUC, $15M 시드). 13개월 사이 9개사 중 4개사 exit(Humanloop 셧다운, W&B/Langfuse/Galileo 피인수) — 통합 국면.
2. **Q2 (brain — AI memory)**: 3대 플랫폼 모두 native memory를 공격적으로 내장 중(OpenAI 2024-02→전체 히스토리 2025-04→"Dreaming" 2026-06; Claude 2025-09/10 + Claude Code auto-memory 2026-02추정; Gemini 2025-02→Personal Intelligence 2026-01→무료티어 2026-03). **그럼에도** 독립 메모리 스타트업에 자금이 계속 유입(Mem0 $24M 2025-10, Cognee €7.5M 2026-02)되고 사용량 성장(Mem0 API 콜 5.3x/6개월). 생존 전략은 일관되게 **cross-platform + enterprise(BYOC/온프렘/컴플라이언스)**. local-first 주권 그 자체를 공개 가격으로 파는 벤더는 0곳 — 전부 커스텀 엔터프라이즈 티어 뒤에 숨김.
3. **Q3 (telepty/orchestrator/수직통합)**: 오케스트레이션 프레임워크 수익은 토큰 수익 대비 **3자릿수 차이**로 미미(최대 공개 ARR = LangChain $12~16M vs Anthropic 런레이트 $14B+). 터미널/브리지 단독 유료화 사례는 사실상 부재 — AI-CLI 브리지 분야에서 브리지 자체에 과금하는 곳은 Omnara($9/mo) 단 1곳, 경쟁 4개는 무료, 2개사는 폐업(Terragon, Bloop). local-first가 돈이 된 사례(Obsidian, Tailscale, Bitwarden, Termius)는 전부 **"local-first 코어 + 호스티드 편의 레이어(sync/relay/coordination)에 과금"** 구조이고, 주권만으로는 도네이션웨어에 머묾(Syncthing, Logseq, Zellij).

---

## Q1 — AI 에이전트 신뢰/평가/거버넌스/감사 시장 (registry 후보)

### 1.1 시장 규모·성장률

| 카테고리/기관 | 기준연도 | 전망 | CAGR | 출처 (발행일) |
|---|---|---|---|---|
| AI Governance — MarketsandMarkets | $0.89B (2024) | $5.78B (2029) | 45.3% | marketsandmarkets.com/Market-Reports/ai-governance-market-176187291.html (2025-01) |
| AI Governance SW — Forrester | — | $15.8B (2030), 전체 AI SW 지출의 7% | 30% | forrester.com/blogs/ai-governance-software-spend-will-see-30-cagr-from-2024-to-2030/ (2024-11-13) |
| AI TRiSM — Precedence | $2.95B (2025) | ~$21.06B (2035) | 21.7% | precedenceresearch.com/ai-trust-risk-and-security-management-market (2025-12-22 갱신) |
| Agentic AI orchestration & memory — Mordor | $6.27B (2025) | $28.45B (2030) | 35.3% | mordorintelligence.com/industry-reports/agentic-artificial-intelligence-orchestration-and-memory-systems-market (2025-07-28 갱신) |
| UK AI Assurance — DSIT (정부) | £1.01B GVA (2024) | 조건부 £18.8B (2035); 보수 시나리오 £6.53B | ~30% (암시) | gov.uk/government/publications/trusted-third-party-ai-assurance-roadmap (2025-09-03) |

**검증 노트** (적대 검증 결과): 기준연도 점추정은 범위 $0.2B~$0.9B로 벤더 간 4~6배 발산(GM Insights $197.9M, Grand View $308.3M vs MnM $890M). Forrester $15.8B는 동료 추정 대비 현저히 높음. Mordor의 "orchestration & memory" 카테고리는 해당 보고서 1건에만 존재. **견고한 신호는 점 TAM이 아니라 20~45% CAGR 성장률 밴드.** Grand View 수치($227.6M/2024 → $1,418.3M/2030)는 검증 1-2로 기각(직접 fetch 403, 교차확인 불충분).

### 1.2 경쟁사 맵 — 포지셔닝 / 자금 / 가격 (2026-06-10 기준, 공식 가격페이지 fetch)

| 회사 | 상태 | 자금/밸류 | 가격 모델 | 출처 |
|---|---|---|---|---|
| LangSmith (LangChain) | 독립, 유니콘 | Series B $125M @ $1.25B (IVP) 2025-10 | Dev 무료 / Plus **$39/seat/mo** + trace 종량($2.50/1k) / Ent 커스텀. ARR $12~16M(2025-06, TechCrunch) | langchain.com/pricing; langchain.com/blog/series-b (2025-10-20); techcrunch.com (2025-07-08) |
| Langfuse | **ClickHouse 피인수** (2026-01-16) | 시드 $4M (Lightspeed/YC) | Hobby 무료 / Core $29 / Pro $199 / Ent $2,499/mo; 셀프호스트 무료(MIT)+유료 Ent 라이선스. Fortune 50 중 19개사 사용 | clickhouse.com/blog/clickhouse-acquires-langfuse (2026-01-16); langfuse.com/pricing |
| Arize AI | 독립 | Series C $70M (Adams Street) 2025-02-20; 누적 ~$131M(추정) | AX Free / Pro $50/mo + span 종량 / Ent(셀프호스팅) | arize.com/blog (2025-02-20); arize.com/pricing |
| Galileo | **Cisco 피인수** (의향 2026-04-09, 완료 2026-05-22 → Splunk Observability 통합) | Series B $45M, 누적 $68M (2024-10-15) | Free / Pro $100/mo / Ent. 2024년 이후 매출 +834%(벤더 주장) | blogs.cisco.com (2026-04-09); galileo.ai/pricing |
| Braintrust | 독립 | Series A $36M @ ~$150M (a16z/Casado) 2024-10-08; 사용자: Notion·Stripe·Vercel·Airtable·Instacart·Zapier | Free / **Pro $249/mo** / Ent(온프렘) | a16z.com/announcement/investing-in-braintrust (2024-10-08); braintrust.dev/pricing |
| Patronus AI | 독립 | Series A $17M (Notable) 2024-05; 누적 $40.1M(Tracxn, 추정) | Dev 무료 / API 종량 $10~20/1k evaluator 콜 / Ent | patronus.ai/blog (2024-05); patronus.ai/pricing |
| Credo AI | 독립 | Series B $21M, 누적 ~$41.3M (2024-07-30) | 엔터프라이즈 contact-sales; 3자 추정 $30K~150K/yr(미검증) | credo.ai/blog (2024-07-30) |
| W&B Weave | **CoreWeave 피인수** ~$1.7B (2025-05-05 완료) | — | Free / Pro $60/mo~ + ingestion 종량 / Ent | prnewswire.com (2025-05-05); wandb.ai/site/pricing |
| Humanloop | **셧다운** — Anthropic이 창업자 3인+직원 acqui-hire(IP 인수 아님), 플랫폼 2025-09-08 오프라인 | — | — | techcrunch.com (2025-08-13) |

**구조적 사실**: 추적한 9개사 중 4개사가 약 13개월 내 exit(Humanloop 2025-08, W&B 2025-05, Langfuse 2026-01, Galileo 2026-05) — eval/observability 단독 사업의 독립 생존이 어려워지고 인프라/플랫폼 대기업으로 흡수되는 통합 국면.

**가격 모델 패턴**: (a) seat+종량 하이브리드(LangSmith $39/seat + trace), (b) 플랫 티어(Langfuse $29~2,499, Galileo $100, Braintrust $249), (c) 순수 종량(Patronus evaluator 콜당), (d) 엔터프라이즈 커스텀(Credo, 전원 최상위 티어). 대표 ARPU 단서: 개발자 개인 $20~50/mo, 팀 $100~250/mo, 엔터프라이즈 $30K~150K/yr(Credo 추정 범위).

### 1.3 규제 동인 (검증 3-0 항목만)

- **EU AI Act**: 금지조항+AI 리터러시 2025-02-02 발효(최초 집행 가능일). GPAI 모델 의무·거버넌스·벌칙 2025-08-02 발효. — artificialintelligenceact.eu/implementation-timeline/ (Regulation (EU) 2024/1689 Art.113 대조 검증)
- **⚠️ Digital Omnibus 연기**: 2026-05 잠정 합의(trilogue 2026-05-06, Council 확인 2026-05-13)로 **고위험 의무가 2026-08 → Annex III 2027-12-02 / Annex I 2028-08-02로 연기**. 컴플라이언스發 최대 수요 파도가 16~24개월 뒤로 밀림. 규칙은 연기일 뿐 폐지 아님. — europarl.europa.eu (2026-03-23); gibsondunn.com omnibus 분석. ("2026-08 대규모 컴플라이언스 웨이브" 주장은 적대 검증 0-3으로 **기각**됨)
- NIST AI RMF·ISO 42001·OECD를 정량적 수요 동인으로 묶는 주장들은 검증에서 기각/근거불충분 — **정량 근거가 선 곳은 EU 레그뿐**.
- **UK DSIT 3자 보증 로드맵** (2025-09-03, 1차 출처, 3-0 검증): "third-party providers have a particularly important role to play in independently verifying the quality and trustworthiness of AI systems" 명시. 524개사/~12,500명 고용/£1.01B GVA(2024). 4대 구조적 갭: ① 스킬 부족 ② AI 시스템 정보 접근 부재 ③ 보증 서비스 품질 불투명 ④ 협력 R&D 포럼 부재. UKAS 인증 체계 미비 = 시장 미성숙 = 신규 진입 여지.

### 1.4 "중립 3자 에이전트 신뢰 레이어"의 틈

- 기존 9개사 **전원이 1st-party 개발 도구/거버넌스 SW**로 포지셔닝 — 중립 인증/감사 기관 포지션 없음(Credo가 가장 근접하나 엔터프라이즈 GRC SW).
- 직접 플레이어 발견 1곳: **AIUC** (Artificial Intelligence Underwriting Company) — 독립 표준 AIUC-1("SOC-2 for AI agents") + 3자 감사 + AI 에이전트 보험(보험료가 감사 결과에 연동). $15M 시드(NFDG=Nat Friedman/Daniel Gross 리드), 2025-07 스텔스 해제. — fortune.com (2025-07-23). 기타 Holistic AI, Babl AI는 미확인(추정).
- **데이터가 시사하는 바**: 틈은 실재(영국 정부가 공식 문서로 시장 갭 4개를 명시; 직접 경쟁자는 시드 단계 1곳뿐). 단 수요 파도는 Omnibus 연기로 2027~28년에 옴 — 2026~27년에는 GPAI 의무·자발적 보증(ISO 42001, UK 로드맵)發 수요만 존재. 그리고 eval 툴 단독 독립 생존이 어렵다는 통합 신호(4/9 exit)는 "신뢰 레이어"가 더 큰 플랫폼의 기능이 될 위험도 동시에 가리킴.

---

## Q2 — AI memory 제품 + 플랫폼 흡수 타임라인 (brain 후보)

### 2.1 플랫폼 native memory 타임라인 (전부 1차/주요 언론 출처)

| 플랫폼 | 시점 | 내용 | 출처 |
|---|---|---|---|
| OpenAI | 2024-02-13 (발표)→2024-04 (Plus 롤아웃) | ChatGPT saved memories + 컨트롤 | openai.com/index/memory-and-new-controls-for-chatgpt/ |
| OpenAI | 2025-04-10 | 전체 대화 히스토리 참조로 확장 (Plus/Pro) | help.openai.com release notes |
| OpenAI | 2025-06-03 | 무료 사용자에 경량 메모리 | bleepingcomputer.com (2025-06-04) |
| OpenAI | **2026-06-04** | "Dreaming" V3 — 백그라운드에서 과거 대화 통독·메모리 자동 개정 | openai.com/index/chatgpt-memory-dreaming/ |
| Anthropic | 2025-09-12 | Claude memory (Team/Ent) + Incognito | anthropic.com/news/memory |
| Anthropic | 2025-09-29 | **API memory tool**(클라이언트사이드, 공개 베타) + context editing; "고객 인프라에 저장" 설계 | claude.com/blog/context-management |
| Anthropic | 2025-10-23 | 소비자 유료 전 티어 메모리 (Max부터) | macrumors.com (2025-10-23) |
| Anthropic | 2026-02 (추정, 2차 출처) | Claude Code **auto memory** — CLAUDE.md + 에이전트가 스스로 노트 작성, 기본 on (v2.1.59+) | code.claude.com/docs/en/memory |
| Google | 2025-02-13 | Gemini Advanced 과거 대화 recall | 9to5google.com |
| Google | 2025-08-13 | Personal context 기본 ON + Temporary Chats | blog.google |
| Google | 2026-01-14 | **Personal Intelligence** — Gmail/Photos/YouTube/Search 히스토리 연동 (US, Pro/Ultra 베타) | blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ |
| Google | 2026-03 (월 추정) | Personal Intelligence 무료 티어 확대 (US) | blog.google |

OpenAI는 API 레벨 1st-party memory API 부재(2026-06 기준, 부재 주장 — 추정). Anthropic의 API memory tool은 의도적으로 **클라이언트사이드**(고객 인프라 저장) — 플랫폼 스스로 "고객 통제 저장소"를 전제로 설계, 즉 메모리 저장 레이어 자체를 프리미엄으로 팔지 않음.

### 2.2 독립 memory 스타트업 — 생존 전략/자금/가격

| 회사 | 자금 | 가격 | 생존 전략 | 출처 |
|---|---|---|---|---|
| Mem0 | **$24M** (시드 $3.9M + Series A $20M, Basis Set 리드, YC/Peak XV/GitHub Fund) 2025-10-28 | Enterprise 종량(커스텀 배포·BYOK·SOC2/HIPAA) | API 콜 35M(2025-Q1)→186M(2025-Q3) = 5.3x, ~30% MoM (회사 자체 보고·비감사). Series B 없음, 다운라운드/셧다운 신호 없음(2026-06 기준) | techcrunch.com (2025-10-28); mem0.ai/series-a |
| Zep | 프리시드 $500K (YC W24) 2024-03; 이후 라운드 미확인 | Free / Flex $1,250/yr / Flex+ $3,750/yr / Ent 커스텀 (BYOK·**BYOC=고객 VPC 배포**·SOC2 II·HIPAA) | temporal knowledge graph (OSS Graphiti) + 엔터프라이즈 배포 옵션 | getzep.com/pricing (2026-06-10 fetch) |
| Letta (ex-MemGPT) | 시드 $10M @ $70M (Felicis) 2024-09-23 | Free / Pro $20/mo / Max $200/mo / Ent | stateful-agent 프레임워크(Apache 2.0, 셀프호스팅 무료) + 클라우드 — 메모리 단독 API가 아닌 프레임워크化 | techcrunch.com (2024-09-23); letta.com/pricing |
| Cognee | **시드 €7.5M** (Pebblebed) **2026-02** | Free OSS / Dev $35/mo / Team $200/mo / **온프렘 Ent 커스텀** | 메모리 그래프(관계형+벡터+그래프 통합), 온프렘 우선, Claude Agent SDK·OpenAI Agents SDK·LangGraph 통합 | eu-startups.com (2026-02); cognee.ai/pricing |
| Supermemory | 시드 $2.6M (Susa) 2025-10 | 종량 (무료 $5 크레딧/mo) | 플랫폼 호환 어댑터 전략 — Anthropic memory-tool 인터페이스 구현 | supermemory.ai/blog (2025-10) |
| LangMem | — (LangChain 기능) | 무료 OSS | 독립 사업 아님 | langchain.com/blog/langmem-sdk-launch (2025-02-18) |

### 2.3 핵심 판단 재료 — 흡수 타임라인과 local-first 유료 증거

- **흡수 압력은 실재하고 가속 중**: 3대 플랫폼 모두 18개월 내 네이티브 메모리를 소비자 기본 기능화(무료 티어까지). Claude Code auto-memory는 "크로스세션 AI 기억"이라는 brain의 사용 사례를 도구 안에 직접 내장. Oracle도 "Unified Memory Core" 발표(2026-03, 2차 출처·추정).
- **그럼에도 독립 레이어는 죽지 않았다**: 2025-10 Mem0 $24M, 2026-02 Cognee €7.5M — 플랫폼 메모리 출시 *이후*에도 투자 유입. 차별점은 일관되게 ① cross-platform(특정 LLM 비종속) ② 에이전트/인프라 레벨(소비자 챗 메모리가 아닌) ③ 엔터프라이즈 통제(BYOC/온프렘/컴플라이언스).
- **유효 수명 추정 (데이터 기반 추정임)**: 소비자·단일 플랫폼 메모리 시장은 이미 흡수 완료. 독립 레이어의 펀딩·사용량 증거는 최소 2026~27년까지의 생존 가능성을 보여주나, Anthropic이 memory tool 인터페이스를 표준화하면(Supermemory가 이미 그 어댑터로 전략 전환) 저장 레이어는 커머디티화 — 인터페이스 표준 등장 후 2~3년 내 차별성 소멸 추정.
- **local-first 유료 의지(WTP) 증거**: 벤더 4/5(Mem0·Zep·Cognee·Langfuse)가 self-hosted/BYOC/온프렘을 **유료 커스텀 엔터프라이즈 티어 뒤에** 게이팅 — 즉 주권 배포는 과금 대상이 맞으나, **공개 가격을 게시한 벤더는 0곳**이고 공개 딜 사이즈도 없음. Letta는 셀프호스팅 무료(주권이 아니라 관리형 통제 기능에 과금). 직접적 매출 증거: 없음/비공개.

---

## Q3 — 멀티에이전트 오케스트레이션 / 터미널 브리지 / local-first moat

### 3.1 오케스트레이션 프레임워크 — 누가 돈을 버나

| 플레이어 | 수익 모델 | 공개 수익 신호 | 출처 |
|---|---|---|---|
| LangChain (LangGraph Platform) | LangSmith seat $39 + trace 종량 + 배포 컴퓨트($0.005/run 등); OSS는 MIT 무료 | **ARR $12~16M** (2025-06, TechCrunch; 회사는 "지금은 더 높다"); $1.25B 밸류 | techcrunch.com (2025-07-08); langchain.com/pricing |
| CrewAI | AMP 플랫폼: Free(50 실행/mo) + Ent 커스텀; 중간 티어($25~99/mo)는 3자 출처(추정) | $18M 조달(2024-10-22, Insight); ARR $3.2M(getlatka, **추정/미검증**); "Fortune 500의 63%"는 벤더 주장 | globenewswire.com (2024-10-22); crewai.com/pricing |
| Microsoft Agent Framework (구 AutoGen+SK) | **무료 MIT OSS → Azure AI Foundry 소비 유도** (프레임워크 직접 수익 $0) | — | devblogs.microsoft.com (2025-10) |
| OpenAI Agents SDK / AgentKit | **무료 → API 토큰 소비** ("Run을 누르기 전까지 무료"); 툴 수수료(Code Interpreter $0.03/세션 등) | — | openai.com/index/introducing-agentkit (2025-10-06) |
| Anthropic Claude Code / Agent SDK | 구독 시트(Pro $20/Max $100~200) + API 토큰; **2026-06-15부터 Agent SDK/headless는 구독 정액에서 분리 → 크레딧 풀+API 과금** (에이전트 사용을 토큰 경제로 이동) | Claude Code 런레이트 $500M(2025-09)→~$1B(2025-11)→$2.5B 보도(2026-02, 2차·추정) | anthropic.com/news (2025-09); support.claude.com (2026); zed.dev/blog (2026-06) |

**핵심 데이터포인트**: 토큰 사이드(Anthropic 전체 런레이트 $14B 2026-02, $30B 보도 2026-04) vs 최대 프레임워크 벤더 공개 ARR(LangChain $12~16M) = **3자릿수(1000배) 격차**. MS·OpenAI는 프레임워크를 의도적 무료 수요 창출 장치로 운영. 오케스트레이션 레이어 자체의 직접 수익화는 LangChain 1곳만 의미 있는 규모이며 그조차 밸류 대비 낮다고 자인.

### 3.2 터미널/세션 브리지 — telepty 영역

**클래식 레이어**: tmux(ISC OSS)·mosh(GPLv3)·Eternal Terminal(Apache 2.0) — 상용 레이어 전무. Zellij — 도네이션($5~20/mo, 리워드는 스티커). 유일한 지속 구독 사업 = **Termius**: Pro ~$9.99/mo(연납)~$19.99, Team $20·Business $30/user/mo — 과금 훅은 **암호화 크로스디바이스 sync(vault)**. 시드 $4.1M, 매출 비공개. (termius.com/pricing, 2026-06-10 fetch). Wave Terminal: OSS, 시드 단계, **유료 티어·사업 모델 미공개**(pre-revenue 추정). Warp: Build $20/mo(1,500 AI 크레딧) + BYOK — BYOK는 GitHub #2788(652 리액션) 수요 대응, **$20/mo가 AI 터미널 시장가** 기준점 (warp.dev/blog, 2025-10-30; 3-0 검증).

**신생 카테고리 — AI 코딩 에이전트의 크로스머신 브리지/원격 제어** (telepty와 가장 가까운 영역):

| 제품 | 과금 | 상태 | 출처 (2026-06-10 fetch) |
|---|---|---|---|
| **Omnara** (YC) | **$9/mo** 무제한 세션(무료 10세션/mo) — **브리지 자체에 과금하는 유일 사례** | 운영 중, 매출 비공개 | omnara.com/pricing |
| Happy (happy.engineering) | 완전 무료·OSS ("no usage fees… no catches"), E2EE | 운영 중 | happy.engineering/docs/faq |
| Conductor (Melty Labs) | 앱 무료 (사용자가 자기 Claude 구독으로 지불) | 운영 중, 수익 0 | conductor.build |
| claude-squad | 무료 OSS | — | github.com/smtg-ai/claude-squad |
| Terragon | (유료 클라우드 에이전트) | **2026-02-09 셧다운**, 코드 오픈소스화 | terragonlabs.com; github.com/terragon-labs/terragon-oss |
| Vibe Kanban (Bloop) | 무료 OSS | 모회사 Bloop **2026 초 셧다운**(2차 출처·추정), 커뮤니티 유지 | github.com/BloopAI/vibe-kanban |
| OpenAI Codex cloud | 브리지 별도 과금 없음 — ChatGPT 구독($20/100/200)에 번들, 2026-04-02 토큰 미터링 전환 | — | developers.openai.com/codex/pricing |
| Google Jules | 무료 15태스크/일; AI Pro $19.99/Ultra $124.99 — 모델 용량에 과금, 브리지에 과금 아님 | — | jules.google/docs/usage-limits |

**패턴(사실)**: 브리지 자체 과금 = Omnara 1곳($9/mo, 규모 비공개). 나머지는 무료이거나, 과금하더라도 모델 용량/구독에 과금. 유료 시도 2건(Terragon, Bloop)은 12개월 내 폐업.

### 3.3 local-first / 데이터 주권 — 유료 전환 동인인가

**성공 사례 (전부 "주권 코어 + 호스티드 편의 레이어 과금" 구조)**:
- **Obsidian**: 코어 무료·local-first. 과금 = Sync $4~8/mo, Publish $10/mo. 상용 라이선스($50/user/yr)는 **2026-02 폐지**(CEO: "산 사람 1명당 미준수 9명"). 무VC·~10인 운영 원칙(kepano, 2023-08). ~1.5M MAU·~$25M ARR·$350M 밸류는 단일 2차 출처 **추정/미검증**. (obsidian.md/pricing)
- **Tailscale**: Series C **$160M @ $1.45B** (Accel, 2025-04-08/09), **유료 비즈니스 고객 10,000곳**(10개월에 2배). 마케팅 핵심이 데이터플레인 주권("control plane은 조정만, 트래픽은 E2EE P2P — 패킷을 만지지 않는다"). 과금은 coordination/관리 레이어(~$18/user/mo). (tailscale.com/blog/series-c, 2025-04; betakit.com)
- **Bitwarden**: OSS·E2EE, $100M 성장 라운드(PSG, 2022-09-06), 수만 기업 고객 — 프라이버시/오픈소스 신뢰가 B2B 유료로 전환된 사례. (techcrunch.com, 2022-09-06)
- **Termius**: 위 참조 — 과금 훅이 암호화 sync.

**실패/비전환 사례**: Syncthing — 10년+ P2P sync, 비영리 재단, **도네이션만**, 상용 제품 없음. Logseq — Sync를 도네이션 백커 티어($5/15) 뒤에 게이팅한 채 정식 구독 미출시. Standard Notes — 구독은 했으나 단독 스케일 실패 → Proton 피인수(2024-04-10). Happy/Conductor/Vibe Kanban — local-first+E2EE 포지셔닝에도 수익 모델 0.

**패턴(사실)**: local-first가 돈이 될 때 과금 대상은 항상 **호스티드 편의(sync/relay/coordination/엔터프라이즈 통제)**이지 local-first 속성 자체가 아님. 주권-온리 모델은 도네이션웨어에 머묾.

### 3.4 "1인/소규모팀 AI 개발 OS" 수요 신호

- 수요 자체는 폭발적이나 **가치가 에이전트/IDE 레이어에 집중**: Cursor ARR $500M+(2025-06)→~$1B(2025말)→$2B 보도(2026-02, 추정); $2.3B Series D @ $29.3B(2025-11-13). Claude Code 런레이트 $500M(GA 4개월)→$1B+(2025-11). Windsurf $82M ARR에서 분할 매각(2025-07). (techcrunch.com 2025-06-05; cnbc.com 2025-11-13)
- 반면 **"개인용 멀티에이전트 매니저" 니치는 전멸 상태**: 조사한 4개 제품(Conductor·Terragon·Vibe Kanban·claude-squad) 중 현재 과금 중 0곳, 12개월 내 2곳 폐업. 수요는 도구(에이전트)에 지불되고, 그 위의 개인용 오케스트레이션 레이어에는 지불되지 않는다는 일관된 신호.

---

## 가설 검증표 (오케스트레이터 5개 가설)

| # | 가설 | 판정 | 근거 요약 |
|---|---|---|---|
| ① | registry(에이전트 신뢰/감사)가 수익화 1순위다 | **검증됨** (단서: 타이밍) | 유일하게 구조적 성장(CAGR 20~45%, 출처 4기관)+정부 공인 갭(UK DSIT 4대 갭)+직접 경쟁 거의 부재(중립 3자 포지션은 AIUC 시드 1곳)가 동시에 성립하는 영역. 단 ⚠️ EU 고위험 컴플라이언스 웨이브는 Omnibus로 2027-12~2028-08로 연기 — 2026~27년 수요는 GPAI 의무+자발적 보증뿐. 그리고 eval 9개사 중 4개사 exit = 단독 생존 난이도 경고. |
| ② | brain은 플랫폼 native 흡수 위험 1순위다 | **검증됨** (단, 즉사 아님) | 3대 플랫폼이 18개월 내 메모리를 기본 기능화(무료 티어까지), Claude Code auto-memory는 brain 사용 사례를 직접 내장 — 흡수 압력 실재·가속. 반면 Mem0 $24M(2025-10)·Cognee €7.5M(2026-02) 등 플랫폼 출시 *후에도* 독립 레이어 투자·성장 지속 — 생존 경로는 cross-platform+엔터프라이즈 통제(BYOC). 유효 수명: 인터페이스 표준화(Anthropic memory tool) 후 2~3년 내 저장 레이어 커머디티화 **추정**. |
| ③ | telepty 단독 유료화는 거의 불가다 | **검증됨** | 클래식 브리지(tmux/mosh/ET) 상용화 0건. AI-CLI 브리지에서 브리지 자체 과금은 Omnara $9/mo 단 1곳(규모 비공개), 무료 4곳, 폐업 2곳(Terragon·Bloop). 유일한 지속 사업 Termius도 과금 훅은 sync 편의. 반증 사례를 적극 탐색했으나 위 1건 외 부재. |
| ④ | local-first 주권은 유료 moat로 약하다 | **검증됨** (정밀화 필요) | 주권 *그 자체*는 과금 포인트가 된 사례 0건(Syncthing·Logseq·Zellij = 도네이션). 단 가설의 정밀화: 주권 아키텍처 **위에 얹은 호스티드 편의 레이어**는 강력한 사업이 됨(Tailscale $1.45B·유료 고객 1만, Obsidian Sync, Bitwarden $100M, Termius). 메모리 벤더 4/5도 주권 배포(BYOC/온프렘)를 유료 엔터프라이즈 티어로 게이팅. 즉 "주권=무료 신뢰 기반, 과금=그 위의 편의/통제". |
| ⑤ | 19-repo 수직통합은 비현실적이다 | **불충분** (간접 데이터는 가설 지지) | 시장 데이터로 내부 실행 가능성을 직접 검증할 수 없음. 단 간접 신호는 일관: 가치가 1~2개 레이어(에이전트·IDE)에 집중(Cursor/Claude Code $1B+ vs 프레임워크 $12~16M vs 개인 오케스트레이션 $0), 인접 레이어 전부를 가진 LangChain($1.25B)도 ARR은 한 자릿수 천만 달러. 수직통합 전체가 동시에 수익화된 비교 사례 없음. |

---

## 데이터가 시사하는 바 (수집 데이터 기반 — 결정은 orchestrator 몫)

1. **순위**: 데이터는 ① registry(성장+갭+정부 공인) 우선을 지지하되, 수익 시점은 2027~28 컴플라이언스 웨이브에 정렬됨. 2026년 단기 수익은 이 시장에서도 dev-tool형 가격(seat $39~249/mo)이 현실적 벤치마크.
2. **brain**: 단독 제품보다 "cross-platform + 고객 인프라 저장(BYOC)" 포지션일 때만 데이터상 생존 사례와 일치. Anthropic memory tool 인터페이스 호환(Supermemory 전략)이 관찰된 적응 패턴.
3. **telepty**: 단독 SKU 데이터 부재. 관찰되는 유일한 과금 구조는 "무료 브리지 + 유료 호스티드 sync/relay"(Termius·Tailscale 패턴) 또는 번들 구성요소화.
4. **가격 벤치마크 (관찰치)**: 개인 dev $9~20/mo (Omnara/Warp/Letta Pro), 팀 $39~249/mo (LangSmith/Braintrust), 엔터프라이즈 $30K~150K/yr (Credo 추정) — aigentry가 어느 레이어로 가든 시장가 레인지.
5. **리스크 공통항**: eval/observability·개인 오케스트레이션 양쪽에서 12~13개월 내 다수 exit/폐업 — 단독 레이어의 독립 생존이 짧아지는 환경. 통합(피인수) 또는 표준 인터페이스 편승이 관찰된 생존 경로.

## 한계·미해결 질문

- TAM 점추정은 전부 단일 벤더 신디케이트 리서치(방법론 불투명) — CAGR 밴드만 인용할 것.
- Mem0 사용량·CrewAI ARR·Obsidian ARR 등은 회사 자체 보고 또는 단일 2차 출처(비감사) — 추정 표기.
- Zep 후속 라운드, Anthropic/OpenAI의 메모리 *로드맵*(출시 전 계획)은 비공개 — 출시 실적 타임라인으로 대체.
- Omnara의 실제 매출 규모(③의 유일 반례) 비공개 — 반례 강도 평가 불가.
- Q1의 2026~27년 "자발적 보증" 수요의 정량 크기(ISO 42001 인증 건수 등) 미수집 — 후속 리서치 후보.

## 출처 목록 (주요, URL + 날짜)

**Q1**: marketsandmarkets.com/Market-Reports/ai-governance-market-176187291.html (2025-01) · forrester.com/blogs/ai-governance-software-spend-will-see-30-cagr-from-2024-to-2030/ (2024-11-13) · precedenceresearch.com/ai-trust-risk-and-security-management-market (2025-12-22) · mordorintelligence.com/industry-reports/agentic-artificial-intelligence-orchestration-and-memory-systems-market (2025-07-28) · gov.uk/government/publications/trusted-third-party-ai-assurance-roadmap (2025-09-03) · artificialintelligenceact.eu/implementation-timeline/ · europarl.europa.eu/news (2026-03-23) · gibsondunn.com (Omnibus, 2026-05) · langchain.com/pricing + /blog/series-b (2025-10-20) · techcrunch.com/2025/07/08 (LangChain ARR) · clickhouse.com/blog/clickhouse-acquires-langfuse (2026-01-16) · arize.com/blog (2025-02-20) · blogs.cisco.com (Galileo, 2026-04-09) · a16z.com/announcement/investing-in-braintrust (2024-10-08) · braintrust.dev/pricing · patronus.ai/pricing · credo.ai/blog (2024-07-30) · prnewswire.com (CoreWeave-W&B, 2025-05-05) · techcrunch.com/2025/08/13 (Humanloop) · fortune.com/2025/07/23 (AIUC)

**Q2**: openai.com/index/memory-and-new-controls-for-chatgpt/ (2024-02-13) · openai.com/index/chatgpt-memory-dreaming/ (2026-06-04) · anthropic.com/news/memory (2025-09-12) · claude.com/blog/context-management (2025-09-29) · macrumors.com (2025-10-23) · code.claude.com/docs/en/memory · blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/ (2026-01-14) · 9to5google.com (2025-02-13) · techcrunch.com/2025/10/28 (Mem0) · mem0.ai/series-a · getzep.com/pricing · techcrunch.com/2024/09/23 (Letta) · eu-startups.com (Cognee, 2026-02) · cognee.ai/pricing · supermemory.ai/blog (2025-10) · langchain.com/blog/langmem-sdk-launch (2025-02-18) · langfuse.com/pricing-self-host

**Q3**: langchain.com/pricing · globenewswire.com (CrewAI, 2024-10-22) · crewai.com/pricing · devblogs.microsoft.com (Agent Framework, 2025-10) · openai.com/index/introducing-agentkit (2025-10-06) · claude.com/pricing · support.claude.com/en/articles/15036540 (2026) · zed.dev/blog/anthropic-subscription-changes (2026-06) · anthropic.com/news (Series F 2025-09 / Series G 2026) · warp.dev/blog/warp-new-pricing-flexibility-byok (2025-10-30) · github.com/warpdotdev/Warp/issues/2788 · termius.com/pricing · omnara.com/pricing · happy.engineering · conductor.build · terragonlabs.com (셧다운 2026-02-09) · github.com/BloopAI/vibe-kanban · developers.openai.com/codex/pricing · jules.google/docs/usage-limits · obsidian.md/pricing · tailscale.com/blog/series-c (2025-04) · betakit.com (2025-04) · techcrunch.com/2022/09/06 (Bitwarden) · techcrunch.com/2024/04/10 (Standard Notes→Proton) · syncthing.net/foundation · opencollective.com/logseq · techcrunch.com/2025/06/05 (Cursor) · cnbc.com/2025/11/13 (Cursor Series D) · techcrunch.com/2025/07/14 (Windsurf)

(전체 fetch 출처 24건 + 갭필 에이전트 4기 수집 출처 — 적대 검증 기각 8건 목록은 워크플로우 로그 `wf_39e3decd-a39` 참조)
