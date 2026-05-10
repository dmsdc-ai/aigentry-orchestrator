# aigentry-amplify Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 기반 콘텐츠 마케팅 프레임워크 MVP — 하나의 소스에서 5개 채널로 콘텐츠를 생성/변환/배포하는 파이프라인 구축.

**Architecture:** pnpm monorepo with packages/core (content-engine, workflow, distributor, auth) + packages/channels (blog, twitter, discord, hn, geeknews). CLI entrypoint delegates to core modules. Plugin-based channel architecture with shared interfaces.

**Tech Stack:** TypeScript, pnpm workspace, vitest, @anthropic-ai/sdk (Claude API), Astro 5 (blog), Node.js CLI

**Spec:** `docs/superpowers/specs/2026-03-15-aigentry-amplify-design.md`

**Session Delegation:**

| Chunk | 담당 세션 | 설명 |
|-------|----------|------|
| 1-6 | aigentry-amplify | 메인 프로젝트 구현 |
| 7 | aigentry-devkit | installer manifest 통합 |
| 8 | aigentry-orchestrator | 라우팅 테이블 + CLAUDE.md 업데이트 |

---

## File Structure

```
aigentry-amplify/
├── package.json                          # root workspace config
├── pnpm-workspace.yaml
├── tsconfig.json                         # base tsconfig
├── tsconfig.build.json                   # build tsconfig (excludes tests)
├── vitest.config.ts
├── marketing.yml.example                 # example config (safe to commit)
├── .env.example                          # required env vars template
├── .gitignore
├── CLAUDE.md                             # AI coding instructions
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # core public API
│   │   │   ├── types.ts                  # all shared interfaces
│   │   │   ├── config.ts                 # marketing.yml loader + .env resolver
│   │   │   ├── content-engine/
│   │   │   │   ├── index.ts              # ContentEngine class
│   │   │   │   ├── generator.ts          # Claude API content generation
│   │   │   │   └── transformer.ts        # source -> channel transforms
│   │   │   ├── workflow/
│   │   │   │   ├── index.ts              # WorkflowManager class
│   │   │   │   ├── manifest.ts           # manifest CRUD
│   │   │   │   └── state-machine.ts      # DRAFT->REVIEW->APPROVED->PUBLISHED
│   │   │   ├── distributor/
│   │   │   │   ├── index.ts              # Distributor class (publish pipeline)
│   │   │   │   ├── registry.ts           # channel plugin registry
│   │   │   │   └── retry.ts             # exponential backoff + jitter
│   │   │   └── auth/
│   │   │       ├── index.ts              # credential loader + validator
│   │   │       └── env-loader.ts         # .env file parser
│   │   └── tests/
│   │       ├── types.test.ts
│   │       ├── config.test.ts
│   │       ├── content-engine/
│   │       │   ├── generator.test.ts
│   │       │   └── transformer.test.ts
│   │       ├── workflow/
│   │       │   ├── manifest.test.ts
│   │       │   └── state-machine.test.ts
│   │       ├── distributor/
│   │       │   ├── registry.test.ts
│   │       │   └── retry.test.ts
│   │       └── auth/
│   │           └── env-loader.test.ts
│   └── channels/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts                  # all channel exports
│       │   ├── blog/
│       │   │   └── index.ts              # BlogChannel plugin
│       │   ├── twitter/
│       │   │   └── index.ts              # TwitterChannel plugin
│       │   ├── discord/
│       │   │   └── index.ts              # DiscordChannel plugin
│       │   ├── hn/
│       │   │   └── index.ts              # HNChannel plugin (manual)
│       │   └── geeknews/
│       │       └── index.ts              # GeekNewsChannel plugin (manual)
│       └── tests/
│           ├── blog.test.ts
│           ├── twitter.test.ts
│           ├── discord.test.ts
│           ├── hn.test.ts
│           └── geeknews.test.ts
├── presets/
│   └── devtool/
│       ├── marketing.yml                 # aigentry devtool preset config
│       └── prompts/
│           ├── blog.md                   # blog post system prompt
│           ├── social.md                 # social media prompt
│           └── community.md             # community posting prompt
├── bin/
│   └── aigentry-amplify.js               # CLI entrypoint (Node.js)
└── templates/
    ├── blog-post.md
    ├── tweet-thread.md
    └── community-post.md
```

---

## Chunk 1: Project Scaffolding (aigentry-amplify session)

### Task 1: Initialize monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `marketing.yml.example`

- [ ] **Step 1: Initialize git repo**

```bash
cd ~/projects/aigentry-amplify
git init
```

- [ ] **Step 2: Create root package.json**

```json
{
  "name": "@dmsdc-ai/aigentry-amplify",
  "version": "0.0.1",
  "private": true,
  "description": "AI-powered content marketing framework — amplify your signal across channels",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/dmsdc-ai/aigentry-amplify.git"
  },
  "bin": {
    "aigentry-amplify": "bin/aigentry-amplify.js"
  },
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "engines": {
    "node": ">=18"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0"
  }
}
```

- [ ] **Step 3: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 6: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 7: Create .gitignore**

```
node_modules/
dist/
.env
marketing.yml
*.tgz
.DS_Store
```

- [ ] **Step 8: Create .env.example**

```bash
# Required: Claude API
ANTHROPIC_API_KEY=

# Twitter/X (v0.1 MVP)
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# Discord
DISCORD_WEBHOOK_URL=
```

- [ ] **Step 9: Create marketing.yml.example**

```yaml
version: 1

brand:
  name: "MyProduct"
  domain: "myproduct.com"
  tone: "professional-friendly"
  language: ["ko", "en"]
  target_audience: "개발자"

preset: devtool

channels:
  enabled:
    - blog
    - twitter
    - discord
    - hn
    - geeknews

  twitter:
    handle: "@myproduct"
  discord:
    channel: "announcements"
  blog:
    output_dir: "./public"

content:
  default_language: "ko"
  review_required: true
```

- [ ] **Step 10: Install dependencies and commit**

```bash
pnpm install
git add -A
git commit -m "chore: initialize aigentry-amplify monorepo"
```

---

### Task 2: Create packages/core scaffold

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create packages/core/package.json**

```json
{
  "name": "@aigentry-amplify/core",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

- [ ] **Step 2: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create packages/core/src/index.ts (empty barrel)**

```typescript
export {};
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/
git commit -m "chore: scaffold packages/core"
```

### Task 3: Create packages/channels scaffold

**Files:**
- Create: `packages/channels/package.json`
- Create: `packages/channels/tsconfig.json`
- Create: `packages/channels/src/index.ts`

- [ ] **Step 1: Create packages/channels/package.json**

```json
{
  "name": "@aigentry-amplify/channels",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@aigentry-amplify/core": "workspace:*"
  }
}
```

- [ ] **Step 2: Create packages/channels/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 3: Create packages/channels/src/index.ts (empty barrel)**

```typescript
export {};
```

- [ ] **Step 4: Commit**

```bash
git add packages/channels/
git commit -m "chore: scaffold packages/channels"
```

---

## Chunk 2: Core Types & Config (aigentry-amplify session)

### Task 4: Define shared types

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/tests/types.test.ts`

- [ ] **Step 1: Write type validation tests**

```typescript
// packages/core/tests/types.test.ts
import { describe, it, expect } from "vitest";
import type {
  Content,
  MediaAsset,
  ChannelContent,
  ChannelConstraints,
  ChannelConfig,
  ValidationResult,
  PublishResult,
  ChannelPublishResult,
  Credentials,
  MarketingConfig,
  BrandConfig,
  ContentManifest,
  ChannelManifestEntry,
  ContentStatus,
  ChannelPlugin,
} from "../src/types.js";

describe("types", () => {
  it("Content satisfies interface", () => {
    const content: Content = {
      id: "test-2026-03-15",
      title: "Test Post",
      body: "# Hello\n\nThis is a test.",
      summary: "A test post for validation.",
      tags: ["test", "aigentry"],
      language: "ko",
      metadata: {},
    };
    expect(content.id).toBe("test-2026-03-15");
  });

  it("ContentManifest satisfies interface", () => {
    const manifest: ContentManifest = {
      id: "test-2026-03-15",
      topic: "Test topic",
      status: "draft",
      source: "blog",
      created: "2026-03-15",
      version: 1,
      channels: {
        blog: { file: "blog.mdx", status: "draft" },
      },
    };
    expect(manifest.status).toBe("draft");
  });

  it("PublishResult tracks per-channel status", () => {
    const result: PublishResult = {
      contentId: "test-1",
      status: "partial",
      channels: {
        twitter: { status: "success", url: "https://x.com/123", retryable: false },
        discord: { status: "failed", error: "Webhook 404", retryable: true },
      },
      timestamp: new Date().toISOString(),
    };
    expect(result.channels.twitter.status).toBe("success");
    expect(result.channels.discord.retryable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- packages/core/tests/types.test.ts
```
Expected: FAIL (types not exported)

- [ ] **Step 3: Implement types.ts**

```typescript
// packages/core/src/types.ts

export type ContentStatus =
  | "draft"
  | "review"
  | "approved"
  | "published"
  | "partially_published";

export interface MediaAsset {
  path: string;
  type: "image" | "video";
  alt?: string;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  language: string;
  images?: MediaAsset[];
  metadata: Record<string, unknown>;
}

export interface ChannelContent {
  channelName: string;
  formatted: string;
  media?: MediaAsset[];
  metadata: Record<string, unknown>;
}

export interface ChannelConstraints {
  maxLength: number;
  mediaRequired: boolean;
  mediaTypes: string[];
  supportsThread: boolean;
}

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ChannelPublishResult {
  status: "success" | "failed" | "skipped" | "rate_limited";
  url?: string;
  error?: string;
  retryable: boolean;
}

export interface PublishResult {
  contentId: string;
  status: "success" | "partial" | "failed";
  channels: Record<string, ChannelPublishResult>;
  timestamp: string;
}

export interface Credentials {
  apiKey?: string;
  accessToken?: string;
  accessSecret?: string;
  refreshToken?: string;
  webhookUrl?: string;
  pageId?: string;
  accountId?: string;
}

export interface BrandConfig {
  name: string;
  domain: string;
  tone: string;
  language: string[];
  target_audience: string;
}

export interface MarketingConfig {
  version: number;
  brand: BrandConfig;
  preset: string;
  channels: {
    enabled: string[];
    [channelName: string]: unknown;
  };
  content: {
    default_language: string;
    review_required: boolean;
  };
}

export interface ChannelManifestEntry {
  file: string;
  status: ContentStatus;
  url?: string;
  error?: string;
}

export interface ContentManifest {
  id: string;
  topic: string;
  status: ContentStatus;
  source: string;
  created: string;
  version: number;
  channels: Record<string, ChannelManifestEntry>;
}

export interface ChannelPlugin {
  name: string;
  type: "api" | "manual";
  init(credentials: Credentials): Promise<void>;
  getConstraints(): ChannelConstraints;
  transform(source: Content, config: ChannelConfig): Promise<ChannelContent>;
  validate(content: ChannelContent): ValidationResult;
  publish(content: ChannelContent): Promise<ChannelPublishResult>;
  healthCheck(): Promise<boolean>;
}
```

- [ ] **Step 4: Export from index.ts**

```typescript
// packages/core/src/index.ts
export * from "./types.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test -- packages/core/tests/types.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/
git commit -m "feat(core): define shared types and interfaces"
```

---

### Task 5: Config loader (marketing.yml + .env)

**Files:**
- Create: `packages/core/src/config.ts`
- Create: `packages/core/src/auth/env-loader.ts`
- Create: `packages/core/src/auth/index.ts`
- Create: `packages/core/tests/config.test.ts`
- Create: `packages/core/tests/auth/env-loader.test.ts`

- [ ] **Step 1: Write config loader tests**

```typescript
// packages/core/tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig, parseYaml } from "../src/config.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

const TMP = join(__dirname, "__tmp_config__");

describe("config", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("parseYaml extracts brand config", () => {
    const yaml = `version: 1\nbrand:\n  name: "Test"\n  domain: "test.com"\n  tone: "casual"\n  language:\n    - ko\n    - en\n  target_audience: "developers"`;
    const config = parseYaml(yaml);
    expect(config.brand.name).toBe("Test");
    expect(config.brand.language).toEqual(["ko", "en"]);
  });

  it("parseYaml extracts enabled channels", () => {
    const yaml = `version: 1\nbrand:\n  name: "T"\n  domain: "t.com"\n  tone: "t"\n  language:\n    - ko\n  target_audience: "t"\nchannels:\n  enabled:\n    - blog\n    - twitter`;
    const config = parseYaml(yaml);
    expect(config.channels.enabled).toEqual(["blog", "twitter"]);
  });

  it("loadConfig reads from file path", () => {
    const yamlPath = join(TMP, "marketing.yml");
    writeFileSync(yamlPath, `version: 1\nbrand:\n  name: "FileTest"\n  domain: "t.com"\n  tone: "t"\n  language:\n    - en\n  target_audience: "t"\npreset: devtool\nchannels:\n  enabled:\n    - blog\ncontent:\n  default_language: en\n  review_required: true`);
    const config = loadConfig(yamlPath);
    expect(config.brand.name).toBe("FileTest");
    expect(config.preset).toBe("devtool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement config.ts (simple YAML parser, no dependency)**

```typescript
// packages/core/src/config.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { MarketingConfig } from "./types.js";

export function parseYaml(raw: string): MarketingConfig {
  const getValue = (key: string): string | null => {
    const m = raw.match(new RegExp(`^\\s*${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
    return m ? m[1] : null;
  };

  const getList = (sectionKey: string, listKey: string): string[] => {
    const sectionIdx = raw.search(new RegExp(`^\\s*${sectionKey}:`, "m"));
    if (sectionIdx === -1) return [];
    const afterSection = raw.slice(sectionIdx);
    const listIdx = afterSection.search(new RegExp(`^\\s*${listKey}:`, "m"));
    if (listIdx === -1) return [];
    const afterList = afterSection.slice(listIdx + afterSection.slice(listIdx).indexOf("\n") + 1);
    const items: string[] = [];
    for (const line of afterList.split("\n")) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (m) items.push(m[1]);
      else if (line.trim() && !line.match(/^\s*#/) && !line.match(/^\s+-/)) break;
    }
    return items;
  };

  const getNestedValue = (section: string, key: string): string | null => {
    const sIdx = raw.search(new RegExp(`^\\s*${section}:`, "m"));
    if (sIdx === -1) return null;
    const afterS = raw.slice(sIdx);
    const nextTop = afterS.slice(1).search(/^\S/m);
    const block = nextTop === -1 ? afterS : afterS.slice(0, nextTop + 1);
    const m = block.match(new RegExp(`^\\s+${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));
    return m ? m[1] : null;
  };

  return {
    version: parseInt(getValue("version") || "1", 10),
    brand: {
      name: getNestedValue("brand", "name") || "",
      domain: getNestedValue("brand", "domain") || "",
      tone: getNestedValue("brand", "tone") || "professional",
      language: getList("brand", "language"),
      target_audience: getNestedValue("brand", "target_audience") || "",
    },
    preset: getValue("preset") || "devtool",
    channels: {
      enabled: getList("channels", "enabled"),
    },
    content: {
      default_language: getNestedValue("content", "default_language") || "ko",
      review_required: getNestedValue("content", "review_required") === "true",
    },
  };
}

export function loadConfig(configPath?: string): MarketingConfig {
  const locations = configPath
    ? [configPath]
    : [
        join(process.cwd(), "marketing.yml"),
        join(process.env.HOME || "", ".config", "aigentry", "marketing.yml"),
      ];

  for (const loc of locations) {
    if (existsSync(loc)) {
      const raw = readFileSync(loc, "utf-8");
      return parseYaml(raw);
    }
  }

  throw new Error(
    "marketing.yml not found. Run: aigentry-amplify init"
  );
}
```

- [ ] **Step 4: Write env-loader tests**

```typescript
// packages/core/tests/auth/env-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadEnvFile, validateChannelCredentials } from "../../src/auth/env-loader.js";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

const TMP = join(__dirname, "__tmp_env__");

describe("env-loader", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("loads .env file into object", () => {
    writeFileSync(join(TMP, ".env"), "FOO=bar\nBAZ=qux\n# comment\nEMPTY=");
    const env = loadEnvFile(join(TMP, ".env"));
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
    expect(env.EMPTY).toBe("");
  });

  it("validateChannelCredentials returns missing keys for twitter", () => {
    const result = validateChannelCredentials("twitter", {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateChannelCredentials passes with all twitter keys", () => {
    const result = validateChannelCredentials("twitter", {
      accessToken: "tok",
      accessSecret: "sec",
      apiKey: "key",
    });
    expect(result.valid).toBe(true);
  });
});
```

- [ ] **Step 5: Implement env-loader.ts and auth/index.ts**

```typescript
// packages/core/src/auth/env-loader.ts
import { readFileSync, existsSync } from "fs";
import type { Credentials, ValidationResult } from "../types.js";

export function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    env[key] = value;
  }
  return env;
}

const CHANNEL_REQUIRED_KEYS: Record<string, string[]> = {
  twitter: ["TWITTER_API_KEY", "TWITTER_ACCESS_TOKEN", "TWITTER_ACCESS_SECRET"],
  discord: ["DISCORD_WEBHOOK_URL"],
  blog: [],
  hn: [],
  geeknews: [],
};

export function validateChannelCredentials(
  channel: string,
  creds: Credentials
): ValidationResult {
  const required = CHANNEL_REQUIRED_KEYS[channel] || [];
  const errors: string[] = [];

  // Map env key names to Credentials fields
  const keyMap: Record<string, keyof Credentials> = {
    TWITTER_API_KEY: "apiKey",
    TWITTER_ACCESS_TOKEN: "accessToken",
    TWITTER_ACCESS_SECRET: "accessSecret",
    DISCORD_WEBHOOK_URL: "webhookUrl",
  };

  for (const key of required) {
    const field = keyMap[key];
    if (field && !creds[field]) {
      errors.push(`Missing ${key} (credentials.${field})`);
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

export function envToCredentials(env: Record<string, string>): Credentials {
  return {
    apiKey: env.TWITTER_API_KEY || env.ANTHROPIC_API_KEY,
    accessToken: env.TWITTER_ACCESS_TOKEN,
    accessSecret: env.TWITTER_ACCESS_SECRET,
    webhookUrl: env.DISCORD_WEBHOOK_URL,
  };
}
```

```typescript
// packages/core/src/auth/index.ts
export { loadEnvFile, validateChannelCredentials, envToCredentials } from "./env-loader.js";
```

- [ ] **Step 6: Update core/src/index.ts exports**

```typescript
// packages/core/src/index.ts
export * from "./types.js";
export * from "./config.js";
export * from "./auth/index.js";
```

- [ ] **Step 7: Run all tests**

```bash
pnpm test -- packages/core/tests/
```
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add config loader and credential management"
```

---

## Chunk 3: Workflow + Content Engine (aigentry-amplify session)

### Task 6: State machine + manifest management

**Files:**
- Create: `packages/core/src/workflow/state-machine.ts`
- Create: `packages/core/src/workflow/manifest.ts`
- Create: `packages/core/src/workflow/index.ts`
- Create: `packages/core/tests/workflow/state-machine.test.ts`
- Create: `packages/core/tests/workflow/manifest.test.ts`

- [ ] **Step 1: Write state machine tests**

```typescript
// packages/core/tests/workflow/state-machine.test.ts
import { describe, it, expect } from "vitest";
import { transition, isValidTransition } from "../../src/workflow/state-machine.js";
import type { ContentStatus } from "../../src/types.js";

describe("state-machine", () => {
  it("allows draft -> review", () => {
    expect(isValidTransition("draft", "review")).toBe(true);
  });

  it("allows review -> approved", () => {
    expect(isValidTransition("review", "approved")).toBe(true);
  });

  it("allows approved -> published", () => {
    expect(isValidTransition("approved", "published")).toBe(true);
  });

  it("allows approved -> partially_published", () => {
    expect(isValidTransition("approved", "partially_published")).toBe(true);
  });

  it("allows partially_published -> published (retry success)", () => {
    expect(isValidTransition("partially_published", "published")).toBe(true);
  });

  it("rejects draft -> published (skip steps)", () => {
    expect(isValidTransition("draft", "published")).toBe(false);
  });

  it("transition returns new status", () => {
    expect(transition("draft", "review")).toBe("review");
  });

  it("transition throws on invalid transition", () => {
    expect(() => transition("draft", "published")).toThrow();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement state-machine.ts**

```typescript
// packages/core/src/workflow/state-machine.ts
import type { ContentStatus } from "../types.js";

const VALID_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  draft: ["review"],
  review: ["approved", "draft"],
  approved: ["published", "partially_published"],
  published: [],
  partially_published: ["published", "partially_published"],
};

export function isValidTransition(from: ContentStatus, to: ContentStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(from: ContentStatus, to: ContentStatus): ContentStatus {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid transition: ${from} -> ${to}`);
  }
  return to;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Write manifest tests**

```typescript
// packages/core/tests/workflow/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createManifest, readManifest, updateManifestStatus, listManifests } from "../../src/workflow/manifest.js";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";

const TMP = join(__dirname, "__tmp_manifest__");

describe("manifest", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("creates manifest directory and file", () => {
    const manifest = createManifest(TMP, {
      topic: "Test topic",
      channels: ["blog", "twitter"],
    });
    expect(manifest.id).toMatch(/^\d{4}-\d{2}-\d{2}-test-topic$/);
    expect(manifest.status).toBe("draft");
    expect(manifest.channels.blog.status).toBe("draft");
  });

  it("reads existing manifest", () => {
    const created = createManifest(TMP, { topic: "Read test", channels: ["blog"] });
    const read = readManifest(join(TMP, created.id));
    expect(read.topic).toBe("Read test");
  });

  it("updates manifest status", () => {
    const created = createManifest(TMP, { topic: "Update test", channels: ["blog"] });
    updateManifestStatus(join(TMP, created.id), "review");
    const read = readManifest(join(TMP, created.id));
    expect(read.status).toBe("review");
  });

  it("lists all manifests", () => {
    createManifest(TMP, { topic: "List A", channels: ["blog"] });
    createManifest(TMP, { topic: "List B", channels: ["blog"] });
    const list = listManifests(TMP);
    expect(list.length).toBe(2);
  });
});
```

- [ ] **Step 6: Implement manifest.ts**

```typescript
// packages/core/src/workflow/manifest.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { ContentManifest, ContentStatus, ChannelManifestEntry } from "../types.js";
import { transition } from "./state-machine.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createManifest(
  contentRoot: string,
  opts: { topic: string; channels: string[] }
): ContentManifest {
  const slug = slugify(opts.topic);
  const id = `${today()}-${slug}`;
  const dir = join(contentRoot, id);

  if (existsSync(dir)) {
    throw new Error(`Content already exists: ${id}`);
  }

  mkdirSync(dir, { recursive: true });

  const channels: Record<string, ChannelManifestEntry> = {};
  for (const ch of opts.channels) {
    const ext = ch === "twitter" ? "json" : "md";
    channels[ch] = { file: `${ch}.${ext}`, status: "draft" };
  }

  const manifest: ContentManifest = {
    id,
    topic: opts.topic,
    status: "draft",
    source: "blog",
    created: today(),
    version: 1,
    channels,
  };

  writeFileSync(join(dir, "manifest.yaml"), serializeManifest(manifest));
  return manifest;
}

export function readManifest(contentDir: string): ContentManifest {
  const manifestPath = join(contentDir, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return deserializeManifest(readFileSync(manifestPath, "utf-8"));
}

export function updateManifestStatus(contentDir: string, newStatus: ContentStatus): void {
  const manifest = readManifest(contentDir);
  manifest.status = transition(manifest.status, newStatus);
  writeFileSync(join(contentDir, "manifest.yaml"), serializeManifest(manifest));
}

export function listManifests(contentRoot: string): ContentManifest[] {
  if (!existsSync(contentRoot)) return [];
  return readdirSync(contentRoot)
    .filter((d) => existsSync(join(contentRoot, d, "manifest.yaml")))
    .map((d) => readManifest(join(contentRoot, d)))
    .sort((a, b) => b.created.localeCompare(a.created));
}

function serializeManifest(m: ContentManifest): string {
  return JSON.stringify(m, null, 2);
}

function deserializeManifest(raw: string): ContentManifest {
  return JSON.parse(raw);
}
```

- [ ] **Step 7: Create workflow/index.ts**

```typescript
// packages/core/src/workflow/index.ts
export { isValidTransition, transition } from "./state-machine.js";
export { createManifest, readManifest, updateManifestStatus, listManifests } from "./manifest.js";
```

- [ ] **Step 8: Update core/src/index.ts**

```typescript
export * from "./types.js";
export * from "./config.js";
export * from "./auth/index.js";
export * from "./workflow/index.js";
```

- [ ] **Step 9: Run all tests, verify PASS**

- [ ] **Step 10: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add workflow state machine and manifest management"
```

---

### Task 7: Content engine (Claude API generator + transformer)

**Files:**
- Create: `packages/core/src/content-engine/generator.ts`
- Create: `packages/core/src/content-engine/transformer.ts`
- Create: `packages/core/src/content-engine/index.ts`
- Create: `packages/core/tests/content-engine/generator.test.ts`
- Create: `packages/core/tests/content-engine/transformer.test.ts`

- [ ] **Step 1: Write transformer tests (no API dependency)**

```typescript
// packages/core/tests/content-engine/transformer.test.ts
import { describe, it, expect } from "vitest";
import { transformToTwitter, transformToDiscord, transformToCommunity } from "../../src/content-engine/transformer.js";
import type { Content } from "../../src/types.js";

const sampleContent: Content = {
  id: "test-1",
  title: "aigentry deliberation 소개",
  body: "# aigentry deliberation\n\n멀티AI 토론 시스템입니다.\n\n## 주요 기능\n\n- 구조화된 토론\n- 합의 도출\n- 멀티 LLM 지원",
  summary: "aigentry의 멀티AI 토론 시스템을 소개합니다.",
  tags: ["aigentry", "deliberation", "ai"],
  language: "ko",
  metadata: {},
};

describe("transformer", () => {
  it("transformToTwitter creates thread within 280 chars each", () => {
    const result = transformToTwitter(sampleContent);
    expect(result.channelName).toBe("twitter");
    const tweets = JSON.parse(result.formatted);
    expect(Array.isArray(tweets)).toBe(true);
    for (const tweet of tweets) {
      expect(tweet.length).toBeLessThanOrEqual(280);
    }
  });

  it("transformToDiscord creates markdown message", () => {
    const result = transformToDiscord(sampleContent);
    expect(result.channelName).toBe("discord");
    expect(result.formatted).toContain(sampleContent.title);
  });

  it("transformToCommunity creates title + body for HN", () => {
    const result = transformToCommunity(sampleContent, "hn");
    expect(result.channelName).toBe("hn");
    expect(result.formatted).toContain(sampleContent.title);
  });

  it("transformToCommunity creates Korean title for GeekNews", () => {
    const result = transformToCommunity(sampleContent, "geeknews");
    expect(result.channelName).toBe("geeknews");
  });
});
```

- [ ] **Step 2: Implement transformer.ts (rule-based transforms, no AI)**

```typescript
// packages/core/src/content-engine/transformer.ts
import type { Content, ChannelContent } from "../types.js";

export function transformToTwitter(source: Content): ChannelContent {
  const tweets: string[] = [];
  // First tweet: title + summary
  tweets.push(`${source.title}\n\n${source.summary}`.slice(0, 280));
  // Split body into chunks
  const sentences = source.body
    .replace(/^#.*$/gm, "")
    .replace(/^-\s*/gm, "• ")
    .split(/\n\n+/)
    .filter((s) => s.trim());
  for (const s of sentences) {
    const trimmed = s.trim().slice(0, 280);
    if (trimmed && !tweets.includes(trimmed)) {
      tweets.push(trimmed);
    }
  }
  // Last tweet: tags
  if (source.tags.length > 0) {
    tweets.push(source.tags.map((t) => `#${t}`).join(" ").slice(0, 280));
  }
  return {
    channelName: "twitter",
    formatted: JSON.stringify(tweets.slice(0, 7)),
    metadata: { tweetCount: Math.min(tweets.length, 7) },
  };
}

export function transformToDiscord(source: Content): ChannelContent {
  const msg = [
    `**${source.title}**`,
    "",
    source.summary,
    "",
    source.body.slice(0, 1800),
    "",
    source.tags.map((t) => `\`${t}\``).join(" "),
  ].join("\n");
  return { channelName: "discord", formatted: msg, metadata: {} };
}

export function transformToCommunity(
  source: Content,
  channel: "hn" | "geeknews"
): ChannelContent {
  const title = source.title;
  const body = channel === "geeknews"
    ? `${source.summary}\n\n${source.body.slice(0, 2000)}`
    : source.summary;
  return {
    channelName: channel,
    formatted: JSON.stringify({ title, body }),
    metadata: { channel },
  };
}
```

- [ ] **Step 3: Write generator tests (mock Claude API)**

```typescript
// packages/core/tests/content-engine/generator.test.ts
import { describe, it, expect, vi } from "vitest";
import { generateBlogPost } from "../../src/content-engine/generator.js";

describe("generator", () => {
  it("generateBlogPost returns Content with expected shape", async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "# Test Post\n\nThis is AI generated content.\n\n## Features\n\n- Feature 1\n- Feature 2" }],
        }),
      },
    };

    const result = await generateBlogPost(
      mockClient as any,
      {
        topic: "Test Topic",
        brandName: "TestBrand",
        tone: "professional",
        language: "ko",
        targetAudience: "developers",
      }
    );

    expect(result.title).toBeTruthy();
    expect(result.body).toContain("Test Post");
    expect(result.tags.length).toBeGreaterThan(0);
    expect(mockClient.messages.create).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4: Implement generator.ts**

```typescript
// packages/core/src/content-engine/generator.ts
import type { Content } from "../types.js";

interface GenerateOptions {
  topic: string;
  brandName: string;
  tone: string;
  language: string;
  targetAudience: string;
  preset?: string;
}

export async function generateBlogPost(
  client: { messages: { create: (params: any) => Promise<any> } },
  opts: GenerateOptions
): Promise<Content> {
  const systemPrompt = [
    `You are a content writer for ${opts.brandName}.`,
    `Tone: ${opts.tone}. Language: ${opts.language}.`,
    `Target audience: ${opts.targetAudience}.`,
    `Write a blog post about the given topic.`,
    `Format: Markdown with # title, ## sections, bullet points.`,
    `Include a 1-2 sentence summary at the very beginning after the title.`,
    `End with suggested tags as a comma-separated list on the last line prefixed with "Tags: "`,
  ].join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: `Topic: ${opts.topic}` }],
  });

  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  const lines = text.split("\n");
  const titleLine = lines.find((l: string) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "") : opts.topic;

  const tagsLine = lines.find((l: string) => l.startsWith("Tags: "));
  const tags = tagsLine
    ? tagsLine.replace("Tags: ", "").split(",").map((t: string) => t.trim()).filter(Boolean)
    : [opts.brandName.toLowerCase()];

  const body = lines
    .filter((l: string) => l !== titleLine && l !== tagsLine)
    .join("\n")
    .trim();

  const summaryMatch = body.match(/^(.+?)(?:\n\n|\n#)/s);
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 200) : title;

  const id = `${new Date().toISOString().slice(0, 10)}-${title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").slice(0, 50)}`;

  return {
    id,
    title,
    body,
    summary,
    tags,
    language: opts.language,
    metadata: { generatedBy: "aigentry-amplify", topic: opts.topic },
  };
}
```

- [ ] **Step 5: Create content-engine/index.ts**

```typescript
export { generateBlogPost } from "./generator.js";
export { transformToTwitter, transformToDiscord, transformToCommunity } from "./transformer.js";
```

- [ ] **Step 6: Update core/src/index.ts**

```typescript
export * from "./types.js";
export * from "./config.js";
export * from "./auth/index.js";
export * from "./workflow/index.js";
export * from "./content-engine/index.js";
```

- [ ] **Step 7: Run all tests, verify PASS**

- [ ] **Step 8: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add content engine with generator and transformer"
```

---

## Chunk 4: Distributor + Channel Plugins (aigentry-amplify session)

### Task 8: Distributor (plugin registry + retry)

**Files:**
- Create: `packages/core/src/distributor/registry.ts`
- Create: `packages/core/src/distributor/retry.ts`
- Create: `packages/core/src/distributor/index.ts`
- Create: `packages/core/tests/distributor/registry.test.ts`
- Create: `packages/core/tests/distributor/retry.test.ts`

(TDD — write tests first, then implement. Same pattern as Tasks 4-7.)

- [ ] **Step 1-4: Registry — register/get/list channel plugins**
- [ ] **Step 5-8: Retry — exponential backoff with jitter, max retries**
- [ ] **Step 9: Distributor index with publishToAll(content, enabledChannels)**
- [ ] **Step 10: Commit**

```bash
git commit -m "feat(core): add distributor with plugin registry and retry logic"
```

### Task 9: Channel plugins (5 channels)

**Files:**
- Create: `packages/channels/src/blog/index.ts`
- Create: `packages/channels/src/twitter/index.ts`
- Create: `packages/channels/src/discord/index.ts`
- Create: `packages/channels/src/hn/index.ts`
- Create: `packages/channels/src/geeknews/index.ts`
- Create: `packages/channels/tests/blog.test.ts`
- Create: `packages/channels/tests/twitter.test.ts`
- Create: `packages/channels/tests/discord.test.ts`
- Create: `packages/channels/tests/hn.test.ts`
- Create: `packages/channels/tests/geeknews.test.ts`

Each plugin implements the `ChannelPlugin` interface. TDD for each:

- [ ] **Step 1-3: BlogChannel** — transform to MDX, validate, publish writes to output dir
- [ ] **Step 4-6: TwitterChannel** — transform to thread, validate 280 char limit, publish via X API
- [ ] **Step 7-9: DiscordChannel** — transform to markdown, validate 2000 char, publish via webhook
- [ ] **Step 10-12: HNChannel** (manual) — transform to title+url, validate, publish returns manual instructions
- [ ] **Step 13-15: GeekNewsChannel** (manual) — same as HN but Korean-optimized
- [ ] **Step 16: Export all from channels/src/index.ts**
- [ ] **Step 17: Commit**

```bash
git commit -m "feat(channels): add blog, twitter, discord, hn, geeknews plugins"
```

---

## Chunk 5: CLI + Presets (aigentry-amplify session)

### Task 10: CLI entrypoint

**Files:**
- Create: `bin/aigentry-amplify.js`

CLI commands (zero-dep Node.js, same pattern as aigentry-devkit):

```
aigentry-amplify init [--preset devtool]    # Create marketing.yml + .env from examples
aigentry-amplify generate <type> --topic    # Generate content (blog/social/all)
aigentry-amplify generate --dry-run         # Show prompt only, no API call
aigentry-amplify review list                # List drafts
aigentry-amplify review show <id>           # Show content detail
aigentry-amplify review approve <id>        # Approve for publishing
aigentry-amplify publish <id> [--channels]  # Publish to channels
aigentry-amplify publish <id> --retry-failed # Retry failed channels
aigentry-amplify publish <id> --dry-run     # Simulate publish
aigentry-amplify auth check                 # Validate credentials
aigentry-amplify status                     # Show content pipeline status
```

- [ ] **Step 1: Create CLI with command routing**
- [ ] **Step 2: Implement init command**
- [ ] **Step 3: Implement generate command**
- [ ] **Step 4: Implement review commands**
- [ ] **Step 5: Implement publish command**
- [ ] **Step 6: Implement auth check command**
- [ ] **Step 7: Implement status command**
- [ ] **Step 8: Verify `node bin/aigentry-amplify.js --help` works**
- [ ] **Step 9: Commit**

```bash
git commit -m "feat: add CLI entrypoint with all MVP commands"
```

### Task 11: Devtool preset

**Files:**
- Create: `presets/devtool/marketing.yml`
- Create: `presets/devtool/prompts/blog.md`
- Create: `presets/devtool/prompts/social.md`
- Create: `presets/devtool/prompts/community.md`
- Create: `templates/blog-post.md`
- Create: `templates/tweet-thread.md`
- Create: `templates/community-post.md`

- [ ] **Step 1-3: Create preset config + prompt templates**
- [ ] **Step 4: Create content templates**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add devtool preset and content templates"
```

### Task 12: CLAUDE.md + final wiring

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md with project-specific instructions**
- [ ] **Step 2: Final integration test — init → generate → review → publish dry-run**
- [ ] **Step 3: Commit**

```bash
git commit -m "docs: add CLAUDE.md and verify full pipeline"
```

---

## Chunk 6: Ecosystem Integration (multi-session)

### Task 13: DevKit integration (aigentry-devkit session)

**Files:**
- Modify: `~/projects/aigentry-devkit/config/installer-manifest.json`
- Modify: `~/projects/aigentry-devkit/config/aigentry.yml.template`
- Create: `~/projects/aigentry-devkit/config/modules/amplify.adapter.json`

- [ ] **Step 1: Add amplify to installer manifest profiles**
- [ ] **Step 2: Add amplify module to aigentry.yml.template**
- [ ] **Step 3: Create amplify health check adapter**
- [ ] **Step 4: Update `aigentry start` workspace sessions default**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add aigentry-amplify module to devkit"
```

### Task 14: Orchestrator update (aigentry-orchestrator session)

**Files:**
- Modify: `~/projects/aigentry-orchestrator/CLAUDE.md`

- [ ] **Step 1: Add amplify to ecosystem component table**

Add to the component table:
```
| amplify | 증폭기 | 콘텐츠 생성, 멀티채널 배포, 마케팅 자동화 |
```

- [ ] **Step 2: Add amplify to 스킬 라우팅 테이블 (if applicable)**
- [ ] **Step 3: Update 제품 포지셔닝 section**
- [ ] **Step 4: Commit**

```bash
git commit -m "docs: add aigentry-amplify to orchestrator routing"
```

---

## Execution Notes

### Session-specific superpowers instructions

**aigentry-amplify session (Chunks 1-5):**
> superpowers:subagent-driven-development 또는 superpowers:executing-plans를 사용하여 이 플랜을 실행하세요.
> TDD 필수: 테스트 먼저 작성 → 실패 확인 → 구현 → 통과 확인 → 커밋.
> dry-run 모드를 구현하여 API 호출 없이 전체 파이프라인 검증 가능하게 하세요.

**aigentry-devkit session (Chunk 6, Task 13):**
> superpowers:executing-plans를 사용하여 Task 13을 실행하세요.
> 기존 installer-manifest.json 패턴을 따르세요.

**aigentry-orchestrator session (Chunk 6, Task 14):**
> CLAUDE.md만 수정. 코드 변경 없음.
