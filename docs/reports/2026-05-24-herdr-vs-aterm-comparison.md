---
date: 2026-05-24
author: aigentry-dustcraw-herdr-research (orchestrator task #452)
purpose: Comparative analysis of herdr.dev terminal vs aterm for product positioning + feature inspiration
status: reference (not a decision, not an ADR)
---

# herdr.dev Terminal vs aterm — Comparative Analysis

## Executive summary

Herdr is not a commercial SaaS terminal in the usual Warp/cmux category; based on public material, it is a young AGPL Rust terminal-native agent multiplexer that deliberately stays inside the user's existing terminal while adding tmux-like persistence, SSH/thin-client remote attach, semantic agent state, and a CLI/socket API. aterm is more vertically integrated: a native macOS-first terminal app for the aigentry ecosystem with Rust core crates, Swift/Metal UI, local IPC, telepty bridge, session persistence, and personal product identity. Herdr currently wins on public positioning, remote terminal attach, protocol/API documentation, and agent-state breadth. aterm keeps defensible differentiation if it doubles down on native desktop quality, daemon-less embedded IPC, telepty-native cross-terminal routing, and the personal/daughter-drawings aesthetic instead of chasing full multiplexer parity.

## 1. herdr.dev profile

### Product positioning

Herdr positions itself as "one terminal for the whole herd": a terminal-native agent runtime and multiplexer that runs inside an existing terminal rather than replacing it with a GUI, Electron app, browser dashboard, or reconstructed chat surface. The official landing page frames the gap between classic multiplexers and desktop agent tools: tmux/Zellij persist terminals but do not know agent state; desktop agent apps surface agent status but move the workflow into their own app. Herdr's answer is persistent real PTY panes, workspaces/tabs/panes, mouse-native TUI controls, detach/reattach, remote attach, and an API agents can drive.

The comparison page reinforces that this is not primarily a code-review/worktree product. It "pairs with" worktree tools while focusing on live interactive agent panes. That is a clear market lane: developers already running Claude Code, Codex, OpenCode, Amp, Pi, or similar CLIs in terminals, especially those juggling several agents across local and remote machines.

### Tech stack (inferred)

Public source and metadata support a Rust-first architecture. The GitHub repository is public, AGPL-3.0 licensed, and GitHub reports Rust as the dominant language. The public `Cargo.toml` describes a single `herdr` package with dependencies including `portable-pty`, `ratatui`, `crossterm`, `tokio`, `serde`, `serde_json`, `toml`, `tracing`, `bincode`, `bytes`, `png`, and `unicode-width`. The docs say Herdr exposes newline-delimited JSON over a Unix domain socket, with CLI wrappers over the same local socket surface. Recent release notes mention client/server protocol versions, a background session server, remote client behavior, worktree API commands, and remote clipboard image bridging.

This is therefore best described as a Rust TUI/session-server binary with a local UDS JSON protocol, not a hosted control plane.

### Pricing + business model

No official pricing page, paid tier, account requirement, hosted service, or enterprise plan was discoverable from the site, docs sitemap, GitHub repo, install docs, or release metadata. The public repository license is AGPL-3.0-or-later, the README says it is free to use, modify, and distribute under that license, and installation is by shell installer, manual GitHub release binaries, or Nix. GitHub shows a sponsor affordance, but that is not a product pricing model. Treat Herdr as FOSS with possible donation/sponsorship, not SaaS, unless later terms appear.

### Target audience

The audience is individual or small-team engineers already comfortable with terminals, SSH, and agent CLIs. Official docs emphasize running Herdr locally, inside SSH, through `herdr --remote`, and from mobile SSH clients. The site displays company logos as "popular with engineers from" signals, but those should be read as community/social proof rather than verified enterprise customers.

### Notable features

The top features are: persistent background session server with detachable clients; real terminal panes instead of terminal emulation inside a separate app; local and SSH/thin-client remote attach; direct attach to one agent or terminal; semantic states (`blocked`, `working`, `done`, `idle`, `unknown`) with rollups from pane to tab/workspace; built-in detection/integrations for multiple coding agents; CLI and local socket API for workspace/tab/pane/agent operations, reads, sends, waits, and subscriptions; theming/keybinding/sidebar configuration; agent skill file that teaches agents how to use Herdr from inside a managed pane.

Recent releases show fast movement: v0.5.0 made persistent server/client behavior default, v0.5.6 added thin remote attach, v0.6.0 introduced keybinding v2 and remote clipboard image bridging, and v0.6.2 added Nix support plus Git worktree CLI/socket API commands.

Public review signal is thin but useful. HN Algolia found a low-comment Herdr submission plus adjacent Rmux-thread comments: one user said Herdr was "great so far" but weak at pane reordering, and Herdr's author replied that pane reordering would be in the next release. GeekNews summarized the same core value proposition positively, especially agent state visibility. These are supplementary signals, not proof of mature market adoption.

## 2. aterm profile

### Architecture summary

aterm is a 3-crate Rust workspace at `/Users/duckyoungkim/projects/aigentry-aterm/Cargo.toml`: `aterm-core`, `aterm-session`, and `aterm-ipc`. `aterm-core` builds both `cdylib` and `lib`, depends on `portable-pty`, `alacritty_terminal`, `tokio` with `rt` and `sync`, `tsnet`, `unicode-normalization`, `cbindgen`, and `cc`, and exposes Rust functionality to the macOS shell through C FFI. The local context file describes a macOS Swift/AppKit shell with `NSView`, `CAMetalLayer`, `NSSplitView`, `TailscaleBusClient`, settings/onboarding/orchestrator UI, and a Metal renderer as the production path.

The prior-art audit at `docs/reports/2026-05-24-aterm-rust-patterns-for-telepty.md` characterizes aterm as sync-first, thread/Condvar oriented, and useful prior art for telepty's Rust migration: atomic writes, NDJSON over UDS, Condvar state waits, UID-based UDS auth, and build metadata are reusable patterns, while thread-per-connection and curl subprocess HTTP are not appropriate for telepty's future cross-machine daemon.

`aterm-ipc/src/server.rs` implements owner-only Unix socket IPC with peer UID checks, tagged `SessionAction` JSON, subscriptions, sequence gap detection, and snapshot recovery. `aterm-core/src/app.rs` owns the app singleton, workspace registration, event bus, telepty bridge registration, and IPC dispatch. `aterm-core/src/pty.rs` owns PTY spawn/read/write, inject queues, lifecycle state, auto-restart, and session entries. `aterm-core/src/mailbox/` adds file-backed ACK/NACK/dead-letter delivery. `aterm-session/src/action.rs` and `types.rs` define the protocol model.

### Differentiators

aterm's differentiators are not the same as Herdr's. It is a native desktop terminal for the aigentry ecosystem, not just a terminal multiplexer. It owns macOS rendering lessons: Metal production rendering, Core Text fallback, Korean/CJK IME concerns, NFC normalization, exact ANSI behavior, settings UI, app bundle requirements, and a personal product aesthetic specified by the orchestrator. It is AI-CLI-native through CLI presets, `aterm list/create/inject/dispatch/tasks/lessons`, workspace restore, telepty session union, and a bridge that registers aterm workspaces with telepty. It is also daemon-less at the aterm layer: IPC is embedded in the app process, with telepty as an optional bridge. One risk: package metadata currently says `UNLICENSED` for npm packages while the dispatch describes aterm as FOSS. That mismatch should be cleaned up before public positioning.

## 3. Side-by-side comparison matrix

| Axis | herdr.dev | aterm | Note |
|------|-----------|-------|------|
| Distribution model | Shell installer, GitHub release binaries, Nix flake; Linux/macOS | npm launcher + platform packages, local `.app` build/install; macOS-first | Herdr is simpler for terminal users; aterm is native-app distribution. |
| Language stack | Rust TUI/server; ratatui/crossterm/portable-pty/tokio inferred from public Cargo | Rust core/session/ipc + Swift/AppKit/Metal shell + C FFI | aterm has richer native UI surface and more platform coupling. |
| Async/sync architecture | Tokio in deps; background server/client and event subscriptions | Sync-first threads, Condvar, mpsc, Mutex; some tokio Notify | Herdr appears more daemon/server shaped; aterm is embedded-app shaped. |
| IPC mechanism | Newline-delimited JSON over Unix domain socket | NDJSON over owner-only UDS with UID auth; telepty bridge uses HTTP via curl | Both converge on local JSON over UDS for agent control. |
| Cross-machine / remote terminal | Strong: SSH, `herdr --remote`, phone SSH, direct terminal attach | Partial: telepty bridge and Tailscale pieces exist, but not native remote UI attach | Herdr wins this axis today. |
| Collaboration features | Multi-client/shared session exists; direct attach has one writable owner; no account/hosted collaboration disclosed | Single-user desktop; external sessions via telepty, no multi-user collaboration disclosed | Neither is a full collaborative terminal product yet. |
| AI integration | Broad agent detection, hooks/plugins, semantic state, agent skill, CLI/socket waits | CLI presets, dispatch, inject queues, tasks/lessons, telepty/devkit integration | Herdr is broader across third-party CLIs; aterm is deeper in aigentry. |
| Theming/customization | Configurable keys, themes, sidebar, notifications, scrollback | Settings UI for font/theme/cursor/language/sidebar and renderer details | aterm can win native UX polish if settings stay comprehensive. |
| Plugin/extension model | Built-in integrations and reusable agent skill; custom status via socket | No general plugin model; devkit and telepty bridges are ecosystem integrations | Herdr's integration story is clearer to outsiders. |
| Pricing | No official pricing discovered; AGPL public source | Intended FOSS per dispatch, but npm metadata says `UNLICENSED` | Herdr has clearer public licensing. |
| FOSS/commercial/source | Public AGPL-3.0-or-later repo | Local/internal repo; public license posture ambiguous from checked metadata | Fix aterm metadata before external comparison. |
| Daemon model | Default background session server + clients; `--no-session` escape hatch | No separate aterm daemon; app-embedded IPC, optional telepty daemon bridge | This is a core positioning split, not a bug. |
| Target audience | Terminal/SSH users running many coding agents, likely individuals and small teams | aigentry users, native macOS desktop orchestration, personal AI terminal workflows | Herdr is broader; aterm is more opinionated. |
| Notable differentiators | Existing terminal, persistence, remote attach, agent state/API | Native Metal terminal, personal aesthetic, daemon-less app IPC, telepty-native orchestration | Differentiation remains real if aterm avoids becoming Herdr-lite. |

Across these axes, the practical story is: Herdr is a public, terminal-native, agent-aware multiplexer; aterm is a native AI terminal shell around aigentry workflows. Herdr's distribution and remote attach reduce adoption friction. aterm's native UI, rendering quality, Korean/CJK work, and orchestrator integration are differentiators only if surfaced as product value rather than buried implementation detail. Both use local JSON protocols, so protocol design lessons transfer cleanly, but their daemon models should not be collapsed by default.

## 4. Findings + recommendations

| Finding | Source | Recommendation for aterm | Risk if ignored |
|---------|--------|-------------------------|-----------------|
| Herdr's remote attach is a crisp user-facing feature. | Cross-machine / remote terminal | For telepty Phase 5b/5c, define `attach/read/send/wait/state` envelopes that let aterm expose remote sessions without adding aterm's own always-on daemon. | aterm looks desktop-only while agent workflows move across SSH/mobile. |
| Herdr's semantic state rollups are more public and broader. | AI integration | Keep aterm's aigentry-specific flow, but formalize a typed agent-state taxonomy and sidebar rollups compatible with telepty events. | Users must manually inspect panes, weakening the AI-native claim. |
| Herdr's API/docs/skill make agent integration self-service. | Plugin / extension model | Generate an aterm/telepty agent skill and API reference from `SessionAction`, not a new plugin runtime yet. | Third-party agent support remains tribal knowledge. |
| aterm's license metadata conflicts with its intended FOSS positioning. | FOSS / commercial / source-available | Align npm/crate/repo license metadata with the intended FOSS license before any public positioning push. | Comparisons against AGPL Herdr will make aterm look closed or unclear. |
| Herdr is a better multiplexer; aterm can be a better native terminal. | Notable differentiators | Do not chase every pane-management feature immediately; prioritize native rendering/IME/settings/personal aesthetic plus telepty bridge quality. | aterm becomes a weaker clone instead of a differentiated aigentry surface. |

## 5. Implications for telepty Phase 5b/5c

Herdr validates the shape telepty already seems to be moving toward: a small, explicit terminal-control envelope with `read`, `send`, `wait`, `attach`, state events, and protocol versions. For Phase 5b/5c, the important lesson is not to copy Herdr's product, but to borrow its clarity: run work where credentials/code live, make local/remote attach feel symmetric, keep semantic agent state separate from visual labels, and support direct attach to one terminal. Telepty should improve on both Herdr and aterm by making envelopes versioned and correlated, auth explicit, event replay/gap recovery durable, and remote transport independent of subprocess `curl`.

## 6. Limitations

No Herdr account was created and no private/login-required content was accessed. I did not find official pricing, blog, or standalone changelog pages; `/pricing`, `/blog`, `/changelog`, and `/docs/changelog` resolved to the canonical landing page HTML rather than distinct indexed pages, while release notes were available through GitHub releases and `latest.json`. Herdr's business model is inferred from public AGPL source, install docs, and lack of pricing page; confidence is medium. Herdr's language stack is inferred from public Cargo/GitHub metadata; confidence is high. Herdr collaboration maturity is inferred from docs and release notes; confidence is medium because I did not run it. Public user-review evidence is thin; confidence is low beyond "early positive/critical signals exist."

For aterm, I read docs and source but did not build or run the app. Architecture, IPC, crate boundaries, and package metadata claims are high confidence from local files. Market/FOSS positioning is medium confidence because the dispatch says FOSS while checked npm metadata says `UNLICENSED`. The daughter-drawings/personal aesthetic is accepted from the orchestrator brief, not independently verified in the source files.

## 7. Sources

- https://herdr.dev/
- https://herdr.dev/compare/
- https://herdr.dev/docs/
- https://herdr.dev/docs/install/
- https://herdr.dev/docs/quick-start/
- https://herdr.dev/docs/how-to-work/
- https://herdr.dev/docs/concepts/
- https://herdr.dev/docs/agents/
- https://herdr.dev/docs/configuration/
- https://herdr.dev/docs/integrations/
- https://herdr.dev/docs/socket-api/
- https://herdr.dev/docs/agent-skill/
- https://herdr.dev/latest.json
- https://herdr.dev/sitemap.xml
- https://github.com/ogulcancelik/herdr
- https://github.com/ogulcancelik/herdr/releases
- https://hn.algolia.com/api/v1/search?query=%22herdr%22
- https://news.hada.io/topic?id=29738
- /Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-24-aterm-rust-patterns-for-telepty.md
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-context.md
- /Users/duckyoungkim/projects/aigentry-aterm/Cargo.toml
- /Users/duckyoungkim/projects/aigentry-aterm/CHANGELOG.md
- /Users/duckyoungkim/projects/aigentry-aterm/AGENTS.md
- /Users/duckyoungkim/projects/aigentry-aterm/CLAUDE.md
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/Cargo.toml
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/app.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/pty.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/session.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/mailbox/
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/tailscale.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-core/src/telepty_bridge.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-ipc/src/server.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-ipc/src/auth.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-session/src/action.rs
- /Users/duckyoungkim/projects/aigentry-aterm/aterm-session/src/types.rs
- /Users/duckyoungkim/projects/aigentry-aterm/npm/aterm/package.json
- /Users/duckyoungkim/projects/aigentry-aterm/npm/aterm-darwin-arm64/package.json
