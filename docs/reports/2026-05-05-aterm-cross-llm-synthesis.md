# aterm Cross-LLM Analysis Synthesis (2026-05-05)

**중요 caveat**: 본 분석은 **code-level static analysis 한정**. 사용자 테스트 기반 피드백 별도 필요 (사용자가 직접 dogfooding으로 추후 제공).

## Methodology

4×2 paired cross-LLM analysis:
- **A architect** (Claude + Codex)
- **B runtime** (Claude + Codex)
- **C backlog** (Claude + Codex)
- **D security** (Claude + Codex)

8 total reports collected. Codex sessions 초기 trust prompt 이슈 (analyst dir trust 부재) → config.toml fix 후 sequential 재실행으로 복구.

## Per-Dimension Reports

| Dimension | Claude | Codex | Output |
|---|---|---|---|
| A architect | 24 findings (BLOCKER:2 MAJOR:11 MEDIUM:8 MINOR:3) | 24 findings (MAJOR:12 MEDIUM:10 MINOR:2) | `~/projects/aigentry-architect/docs/aterm-analysis-A-architect-codex-2026-05-05.md` + Claude `/tmp/aigentry-dispatch/aterm-A-architect-claude-report.md` |
| B runtime | 13 bugs (FUNCTIONAL:6 PERF:1 MINOR:6) | 13 bugs (FUNCTIONAL:9 PERF:1 MINOR:3) | `/tmp/aigentry-reports/aterm-runtime-analysis-{claude,codex}-2026-05-05.md` |
| C backlog | 37 tasks audited | 37 tasks audited | `~/projects/aigentry-architect/docs/spec-aterm-c-backlog-claude.md` + `~/projects/aigentry-architect/docs/triage/2026-05-05-aterm-backlog-gap-C-codex.md` |
| D security | 11 findings (HIGH:3 MEDIUM:4 LOW:4) | 13 findings (HIGH:4 MEDIUM:6 LOW:3) | `/tmp/aigentry-dispatch/aterm-D-security-report{,-codex}.md` |

## Top Critical Findings (Cross-LLM 합의)

### 1. d309067 IME fix 회귀 (B-runtime, 양 LLM 다른 측면 발견)
- **Claude**: Shift+Enter modifier flag loss during IME composition (input handling)
- **Codex**: delayed CR write fetches new corePointer → text와 Enter가 다른 workspace로 split 가능 (race condition)
- 해결: 두 측면 통합 fix 필요. 양 LLM의 fix 권고 결합

### 2. macOS Supply-chain Compromise Risk (D-security, 강한 합의)
- ad-hoc codesign + npm postinstall `xattr -cr` quarantine bypass
- npm tampering 시 silent native app 실행 가능
- 해결 (양 LLM 합의): DeveloperID sign + notarize + `xattr -cr` 제거

### 3. Architecture Drift (A-architect, 양 LLM 합의)
- Ghost root crate (src-v3/main.rs 부재 + Cargo.toml [[bin]] 선언)
- 3621 LOC dead wgpu renderer (undefined feature gate)
- 5GB Tauri/Svelte 잔재 (root package.json, src/, vite.config.js)
- 헌법 Art.1 (경량) + Art.17 (무의존) 위반

### 4. 대형 파일 (A-architect, 양 LLM 합의)
- AppDelegate.swift 2522 LOC
- lib.rs 2918 LOC
- 분할 필요

### 5. Dependency hygiene (D-security, 강한 합의)
- vite >= 7.3.2 (HIGH advisory)
- picomatch HIGH (transitive)
- Go 1.20.14 EOL (via tsnet) → Go >= 1.22 or tsnet 제거
- lru unsound, paste unmaintained, alacritty rc, winit vendored

## Backlog Adjustments (양 LLM 일치)

- **CLOSE** #173 (dup of #309 cross-OS strategy)
- **DEMOTE** #78 voicecode-FFI P1→P2 (voicecode 프로젝트 부재)
- **#352 release-lane** (publish 보류 적절, build commit `d309067` 완료)

## Codex unique 발견
- **PROMOTE** #309 → P1 (cross-OS strategy 시급)
- **CLOSE** #125 stale (luminance code 이미 존재)
- **Umbrella** #27 consolidate (4platform IME 통합)
- "Remove Claude trust auto-accept" — 오늘 codex trust prompt 발견과 일관

## Claude unique 발견
- **BLOCKED_BY**: #77 ← #76 (sub-folder taskboard depends on hierarchical WorkspaceManager)
- **RECLASSIFY** #137 → ecosystem track (precondition for #155)

## 신규 백로그 후보 (분석 발견)

| 제안 ID | Pri | 내용 |
|---|---|---|
| #353 | P0 | IME 회귀 통합 fix (Shift+Enter modifier + delayed CR PTY pointer race) — `d309067` 추가 작업 |
| #354 | P0 | macOS supply-chain 보안 — DeveloperID notarize + npm postinstall `xattr -cr` 제거 + Claude trust auto-accept 검토 |
| #355 | P1 | Ghost crate + dead wgpu renderer cleanup (3621 LOC) |
| #356 | P1 | Tauri/Svelte stack 제거 (root package.json, src/, vite.config.js, index.html) |
| #357 | P2 | 대형 파일 분할 (AppDelegate.swift 2522 LOC + lib.rs 2918 LOC) |
| #358 | P2 | npm/Cargo dep 업데이트 (vite, picomatch, postcss, Go>=1.22, lru, paste 추적) |
| #359 | P2 | Tailscale boundary ADR (devkit/telepty/aterm 영역 결정) |

## 추가 fix 발견 사항 (sub-recommendations)

- aterm-bridge.h vs cbindgen ABI drift — single-source 정리
- 50 unwrap() → Result 전환 (panic risk)
- Swift fatalError → recoverable error (renderer paths)
- 5platform ADR — public claim "5 native platforms" → 실제는 macOS arm64 only ship

## 다음 단계 (사용자 결정 대기)

1. **사용자 dogfooding 피드백 수집** ⭐ (이 보고서는 code-level 한정, 실 UX는 사용자 직접 테스트 필요)
2. 신규 백로그 task 추가 (#353-#359) — 사용자 confirm 후
3. 백로그 조정 (CLOSE/DEMOTE/PROMOTE) — 사용자 confirm 후
4. Critical fix dispatch (#353 IME 회귀 + #354 보안) — #352 publish 차단 해소

