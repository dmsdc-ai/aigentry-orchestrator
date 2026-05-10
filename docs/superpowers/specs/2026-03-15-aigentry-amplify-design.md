# aigentry-amplify Design Spec

**Date:** 2026-03-15
**Status:** Approved (pending spec review)
**Package:** `@dmsdc-ai/aigentry-amplify`
**Ecosystem Role:** 증폭기 (Amplifier) — 콘텐츠를 생성하고 멀티채널로 증폭/배포

---

## 1. Overview

aigentry-amplify는 AI 기반 콘텐츠 마케팅 프레임워크입니다.

**두 가지 역할:**
1. **aigentry 자체 마케팅** — devtool 프리셋으로 aigentry 에코시스템을 홍보 (도그푸딩)
2. **퍼블릭 프레임워크** — 사용자가 자기 도메인에 맞춰 AI 마케팅 파이프라인을 구축

**핵심 원칙:**
- 하나의 소스 → 다중 채널 배포 (1 source, N channels)
- 반자동: AI 초안 + 사람 검토 후 배포
- 플러그인 채널 아키텍처 (marketing.yml에서 enable/disable)
- OMC 독립 동작 (aigentry 자체 런타임)

**확장 전략:**
- 모노레포로 시작. 프로젝트가 1M 토큰을 초과하면 마이크로서비스로 물리적 분리.

---

## 2. Architecture

### 프로젝트 구조

```
aigentry-amplify/
├── packages/
│   ├── core/
│   │   ├── content-engine/    # Claude API 콘텐츠 생성기
│   │   ├── distributor/       # 채널 플러그인 시스템
│   │   ├── workflow/          # 상태 머신 (DRAFT → REVIEW → PUBLISHED)
│   │   └── analytics/        # 성과 수집 (v0.2)
│   ├── channels/              # 채널 플러그인
│   │   ├── blog/              # Astro 5 + MDX
│   │   ├── youtube/           # YouTube Data API v3
│   │   ├── twitter/           # X API v2
│   │   ├── linkedin/         # LinkedIn API
│   │   ├── threads/          # Meta Threads API
│   │   ├── instagram/        # Instagram Graph API
│   │   ├── facebook/         # Facebook Pages API
│   │   ├── tiktok/           # TikTok API
│   │   ├── reddit/           # Reddit API
│   │   ├── discord/          # Discord Bot/Webhook API
│   │   ├── producthunt/      # Product Hunt API (v0.2)
│   │   ├── hn/               # Hacker News (수동 게시 헬퍼)
│   │   └── geeknews/         # GeekNews (수동 게시 헬퍼)
│   └── video/                 # Remotion 영상 생성 (v0.2)
├── presets/                   # 도메인별 프리셋
│   ├── devtool/               # 개발자 도구 (aigentry 기본)
│   ├── saas/                  # SaaS 제품 (v0.2)
│   ├── creator/               # 크리에이터 (v0.2)
│   └── ecommerce/             # 이커머스 (v0.2)
├── content/                   # 콘텐츠 저장소 (콘텐츠 중심 구조)
│   └── {date}-{slug}/        # 하나의 콘텐츠 = 하나의 디렉토리
│       ├── manifest.yaml      # 메타데이터 + 채널별 상태
│       ├── blog.mdx           # 블로그 원본
│       ├── twitter.json       # 트위터 스레드
│       ├── discord.md         # Discord 공지
│       ├── hn.md              # HN 포스트
│       └── geeknews.md        # GeekNews 포스트
├── templates/                 # 채널별 콘텐츠 템플릿
├── bin/
│   └── aigentry-amplify.js    # CLI 엔트리포인트
├── package.json               # pnpm workspace
├── marketing.yml              # 사용자 설정 (brand, channels, tone)
└── CLAUDE.md
```

### 데이터 흐름

```
[소스]                    [content-engine]          [content/]      [사람]        [distributor]     [채널]
토픽 제안 ──────→ AI 초안 생성 ──────→ 채널별 콘텐츠 ──→ 검토/수정 ──→ 멀티채널 배포 ──→ blog
(dustcraw/수동)    (Claude API)        (MDX/JSON/MD)    (REVIEW)      (PUBLISHED)      twitter
                                                                                        linkedin
                                                                                        threads
                                                                                        instagram
                                                                                        facebook
                                                                                        tiktok
                                                                                        reddit
                                                                                        discord
                                                                                        youtube
                                                                                        hn
                                                                                        geeknews
```

### 에코시스템 연동

| 연동 대상 | 방향 | 소유권 | 내용 |
|----------|------|--------|------|
| dustcraw → amplify | 입력 | dustcraw | dustcraw가 토픽 제안 API 노출. amplify는 thin client만 구현 |
| brain → amplify | 입력/출력 | brain | brain이 성과 기억 API 노출. amplify는 thin client만 구현 |
| deliberation → amplify | 검증 | deliberation | MCP 도구 호출로 검증. amplify 내 로직 없음 |
| devkit → amplify | 설치 | devkit | devkit installer manifest에 amplify 프로필 추가 |

---

## 3. Content Engine

### 구조

```
content-engine/
├── generators/
│   ├── blog-generator.ts      # 블로그 포스트 초안
│   ├── video-script.ts        # 영상 스크립트 생성
│   ├── social-adaptor.ts      # 원본 → 소셜 채널 변환
│   └── community-adaptor.ts   # 원본 → 커뮤니티 최적화
├── prompts/
│   ├── blog.md                # 블로그 시스템 프롬프트
│   ├── video.md               # 영상 스크립트 프롬프트
│   ├── social.md              # 소셜 미디어 프롬프트
│   └── community.md           # 커뮤니티 프롬프트
├── transforms/
│   ├── blog-to-social.ts      # 블로그 → 트위터/LinkedIn/Threads/Instagram/Facebook
│   ├── blog-to-video.ts       # 블로그 → 영상 스크립트
│   └── blog-to-community.ts   # 블로그 → HN/Reddit/GeekNews
└── index.ts
```

### 1-source-N-channels 변환

```
[블로그 포스트 (원본)]
    ├─→ Twitter 스레드 (5-7트윗 요약)
    ├─→ LinkedIn 포스트 (전문적 톤)
    ├─→ Threads 포스트 (캐주얼 톤)
    ├─→ Instagram 캡션 + 이미지 프롬프트 (비주얼 중심)
    ├─→ Facebook 포스트 (커뮤니티 톤)
    ├─→ TikTok 스크립트 + 캡션 (숏폼)
    ├─→ Reddit 포스트 (기술적 톤 + 토론 유도)
    ├─→ HN 제출 (제목 최적화)
    ├─→ GeekNews 제출 (한국어 번역 + 톤 조정)
    ├─→ YouTube 스크립트 (데모 시나리오 포함)
    └─→ Discord 공지 (짧은 요약 + 링크)
```

### 프롬프트 파라미터

content-engine의 프롬프트는 `marketing.yml`의 브랜드 설정을 주입받음:
- `brand.name` — 브랜드명
- `brand.tone` — 톤 (professional, casual, technical, friendly 등)
- `brand.language` — 언어 목록
- `brand.target_audience` — 타겟 오디언스 설명
- `preset` — 프리셋별 도메인 특화 지시

---

## 3.5. Credentials & Secrets

### Storage Strategy

- **Config (safe to commit):** `marketing.yml` — brand, tone, channel settings (no secrets)
- **Secrets (gitignored):** `.env` — API keys, OAuth tokens, webhook URLs
- **Template:** `.env.example` — documents required variables per channel

### .env.example

```
# Required for enabled channels
ANTHROPIC_API_KEY=        # Claude API (content engine)

# Twitter/X
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# LinkedIn
LINKEDIN_ACCESS_TOKEN=

# Meta (Threads, Instagram, Facebook)
META_ACCESS_TOKEN=
META_PAGE_ID=
META_INSTAGRAM_ACCOUNT_ID=

# Reddit
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_REFRESH_TOKEN=

# Discord
DISCORD_WEBHOOK_URL=

# YouTube
YOUTUBE_API_KEY=
```

### OAuth Strategy

**MVP (v0.1):** 사용자가 외부에서 토큰을 사전 발급받아 `.env`에 설정. CLI는 `aigentry-amplify auth check`로 토큰 유효성 검증만 수행.

**v0.2:** `core/auth/` 모듈 추가 — OAuth2 device flow, 토큰 자동 갱신, 토큰 암호화 저장.

### Credentials Type

```typescript
interface Credentials {
  apiKey?: string;
  accessToken?: string;
  accessSecret?: string;
  refreshToken?: string;
  webhookUrl?: string;
  pageId?: string;
  accountId?: string;
}

// 시작 시 필수 credential 검증
function validateCredentials(channel: string, creds: Credentials): ValidationResult;
```

### Security Rules

- `.env` is always in `.gitignore`
- `marketing.yml` MUST NOT contain secrets
- CLI warns if secrets detected in `marketing.yml`
- `${VAR}` syntax in `marketing.yml` resolves from `process.env` (documented explicitly)

---

## 4. Workflow

### 상태 머신 (MVP)

```
DRAFT → REVIEW → APPROVED → PUBLISHED
                              ↓ (일부 실패 시)
                        PARTIALLY_PUBLISHED
```

| 상태 | 행위자 | 설명 |
|------|--------|------|
| DRAFT | AI | Claude API로 원본 + 채널별 변환 생성 |
| REVIEW | 사람 | 콘텐츠 검토 + 수정 |
| APPROVED | 사람 | 배포 승인 |
| PUBLISHED | 시스템 | 전체 채널 배포 성공 |
| PARTIALLY_PUBLISHED | 시스템 | 일부 채널 실패. 재시도 가능 |

### Error Handling & Retry

```typescript
interface PublishResult {
  contentId: string;
  status: 'success' | 'partial' | 'failed';
  channels: Record<string, ChannelPublishResult>;
  timestamp: string;
}

interface ChannelPublishResult {
  status: 'success' | 'failed' | 'skipped' | 'rate_limited';
  url?: string;        // 게시된 URL
  error?: string;      // 실패 원인
  retryable: boolean;  // 재시도 가능 여부
}
```

- **재시도:** `aigentry-amplify publish <id> --retry-failed` (실패 채널만 재시도)
- **Rate limit:** 채널별 rate limit 인지. 초과 시 자동 대기 후 재시도 (exponential backoff + jitter)
- **Idempotency:** 이미 성공한 채널은 재배포하지 않음 (매니페스트에 per-channel status 기록)

### 콘텐츠 매니페스트

```yaml
# content/2026-03-15-deliberation-intro/manifest.yaml
id: deliberation-intro-2026-03-15
topic: "aigentry deliberation으로 멀티AI 토론하기"
status: draft
source: blog
created: 2026-03-15
version: 1
channels:
  blog:
    file: blog.mdx
    status: draft
  twitter:
    file: twitter.json
    status: draft
  discord:
    file: discord.md
    status: draft
  hn:
    file: hn.md
    status: draft
  geeknews:
    file: geeknews.md
    status: draft
```

---

## 5. Channel Plugin Architecture

### 인터페이스

```typescript
interface Content {
  id: string;
  title: string;
  body: string;           // 원본 마크다운
  summary: string;        // 1-2문장 요약
  tags: string[];
  language: string;
  images?: MediaAsset[];
  metadata: Record<string, unknown>;
}

interface MediaAsset {
  path: string;
  type: 'image' | 'video';
  alt?: string;
}

interface ChannelContent {
  channelName: string;
  formatted: string;      // 채널 포맷에 맞게 변환된 콘텐츠
  media?: MediaAsset[];
  metadata: Record<string, unknown>;  // 채널 특화 메타 (예: tweet IDs, subreddit)
}

interface ChannelConstraints {
  maxLength: number;       // 최대 글자 수
  mediaRequired: boolean;  // 이미지/영상 필수 여부
  mediaTypes: string[];    // 허용 미디어 타입
  supportsThread: boolean; // 스레드/시리즈 지원
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ChannelPlugin {
  name: string;
  type: 'api' | 'manual';

  // 초기화 (credential 검증)
  init(credentials: Credentials): Promise<void>;

  // 채널 제약 조건
  getConstraints(): ChannelConstraints;

  // 콘텐츠 변환
  transform(source: Content, config: ChannelConfig): Promise<ChannelContent>;

  // 검증 (제약 조건 체크)
  validate(content: ChannelContent): ValidationResult;

  // 배포 (api 타입만)
  publish(content: ChannelContent): Promise<ChannelPublishResult>;

  // 헬스 체크
  healthCheck(): Promise<boolean>;
}
```

### 채널 레지스트리

```typescript
// distributor/channel-registry.ts
const registry = new Map<string, ChannelPlugin>();

function registerChannel(plugin: ChannelPlugin): void;
function getChannel(name: string): ChannelPlugin | undefined;
function listChannels(): ChannelPlugin[];
function getEnabledChannels(config: MarketingConfig): ChannelPlugin[];
```

### MVP 채널 목록 (v0.1)

| 채널 | 타입 | API | MVP |
|------|------|-----|-----|
| blog | api | Astro build + deploy | O |
| twitter | api | X API v2 | O |
| linkedin | api | LinkedIn API | O |
| threads | api | Meta Threads API | O |
| instagram | api | Instagram Graph API | O |
| facebook | api | Facebook Pages API | O |
| tiktok | manual | 스크립트+캡션만 | △ |
| reddit | api | Reddit API | O |
| discord | api | Discord Webhook | O |
| youtube | manual | 스크립트만 (v0.2 업로드) | △ |
| hn | manual | 제목/설명 최적화 | O |
| geeknews | manual | 한국어 최적화 | O |
| producthunt | api | PH API | X (v0.2) |

---

## 6. User Configuration

### marketing.yml

```yaml
version: 1

brand:
  name: "MyProduct"
  domain: "myproduct.com"
  tone: "professional-friendly"
  language: ["ko", "en"]
  target_audience: "SaaS 기업 의사결정자"

preset: devtool  # devtool | saas | creator | ecommerce

channels:
  enabled:
    - blog
    - twitter
    - linkedin
    - threads
    - instagram
    - facebook
    - reddit
    - discord
    - youtube
    - hn
    - geeknews

  twitter:
    handle: "@myproduct"
  linkedin:
    company_id: "12345"
  instagram:
    account_id: "67890"
  discord:
    channel: "announcements"  # Discord 채널 이름 (URL은 .env에)
  blog:
    deploy_target: "vercel"  # vercel | cloudflare | static

content:
  default_language: "ko"
  auto_translate: true
  review_required: true
```

### CLI

```bash
# 초기 설정
npx @dmsdc-ai/aigentry-amplify init --preset devtool

# 콘텐츠 생성
aigentry-amplify generate blog --topic "aigentry deliberation 소개"
aigentry-amplify generate social --source content/posts/2026-03-15-deliberation.mdx
aigentry-amplify generate all --topic "신기능 출시"

# 검토
aigentry-amplify review list
aigentry-amplify review show <id>
aigentry-amplify review approve <id>

# 배포
aigentry-amplify publish <id>
aigentry-amplify publish <id> --channels blog,twitter,linkedin
aigentry-amplify publish <id> --retry-failed

# 인증
aigentry-amplify auth check

# 상태
aigentry-amplify status
```

---

## 7. Tech Stack

| 레이어 | 기술 | 근거 |
|--------|------|------|
| 언어 | TypeScript | 에코시스템 일관성 |
| 패키지 매니저 | pnpm workspace | 모노레포 관리 |
| 블로그 | Astro 5 + MDX + Tailwind | 정적 사이트, 콘텐츠 중심, 빠른 빌드 |
| 영상 (v0.2) | Remotion | React → MP4 프로그래매틱 영상 |
| AI | Claude API (@anthropic-ai/sdk) | 콘텐츠 생성 엔진 |
| CLI | Node.js (minimal deps) | devkit 패턴 따름. 최소 의존성 원칙 |
| 배포 | Vercel / Cloudflare Pages | 블로그 정적 배포 |
| CI/CD | GitHub Actions | 자동 빌드/배포 |

---

## 8. Ecosystem Positioning

```
aigentry 에코시스템 (인체 비유)

telepty       → 신경계 (transport)
deliberation  → 두뇌 (semantic control)
dustcraw      → 감각기관 (crawling)
brain         → 기억 (knowledge)
registry      → 면역계 (trust)
devkit        → 골격계 (install, infra)
orchestrator  → 지휘자 (control tower)
amplify       → 증폭기 (content amplification) ← NEW
```

**제품 티어:** Core (기본 콘텐츠 생성 + 수동 채널) / Full (자동 배포 + 전체 채널 + analytics)

---

## 9. MVP Scope (v0.1)

### 포함
- core/content-engine (Claude API 기반 콘텐츠 생성)
- core/workflow (DRAFT → REVIEW → APPROVED → PUBLISHED + PARTIALLY_PUBLISHED)
- core/distributor (채널 플러그인 레지스트리 + 에러 핸들링)
- core/auth (credential 검증만. OAuth 플로는 v0.2)
- 채널 플러그인:
  - **blog** (Astro: MDX 파일 생성만. 배포는 사용자 책임)
  - **twitter** (X API v2: 트윗 + 스레드)
  - **discord** (Webhook: 가장 단순한 API 채널)
  - **hn** (수동 게시: 제목/설명 최적화)
  - **geeknews** (수동 게시: 한국어 최적화)
- presets/devtool
- CLI (init, generate, review, publish, status, auth check)
- marketing.yml + .env 설정 시스템
- dry-run 모드 (--dry-run: 콘텐츠 생성만, 배포 안 함)

### 미포함 (v0.2)
- core/analytics (성과 수집)
- core/auth OAuth2 플로 (자동 토큰 갱신)
- video/ (Remotion 영상 렌더링)
- 추가 채널: linkedin, threads, instagram, facebook, tiktok, reddit, producthunt
- YouTube/TikTok 영상 업로드
- presets/saas, creator, ecommerce
- 예약 배포 (scheduling)
- 콘텐츠 버저닝

---

## 10. Testing Strategy

### 단위 테스트
- content-engine: 변환 로직 (blog → social, blog → community)
- workflow: 상태 전이 검증
- 채널 플러그인: validate(), transform() 테스트

### 통합 테스트
- 채널 플러그인: mock API 서버로 publish() 테스트
- CLI: 커맨드별 E2E (init → generate → review → publish)

### dry-run 모드
- `aigentry-amplify publish <id> --dry-run` — 콘텐츠 생성 + 변환까지만. 실제 API 호출 없음.
- `aigentry-amplify generate --dry-run` — 프롬프트 표시만. Claude API 호출 없음.

### 테스트 프레임워크
- vitest (에코시스템 일관성: brain, deliberation 모두 vitest 사용)

---

## 11. npm Package

```
@dmsdc-ai/aigentry-amplify
```

```bash
# 퍼블릭 사용자 원클릭 셋업
npx @dmsdc-ai/aigentry-amplify init
```
