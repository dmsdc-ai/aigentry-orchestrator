# aigentry-orchestrator

**The orchestration layer for the [aigentry](https://github.com/dmsdc-ai) ecosystem** — spawns AI CLI sessions, routes work between them, and persists session state.

> ⚠️ **Internal infrastructure, not a public product.** This is the control tower that coordinates aigentry sessions. It is not published to npm and has no public install path. If you want to *use* aigentry, start with the [aigentry meta-installer](https://github.com/dmsdc-ai/aigentry) or [telepty](https://github.com/dmsdc-ai/aigentry-telepty).

## What it does

- **Spawn** — opens AI CLI sessions (orchestrator + worker roles) across terminals
- **Route** — dispatches tasks to sessions and collects their reports back
- **Persist** — tracks session state and hierarchy across a run

## Scope

Orchestration infra for the aigentry ecosystem — not a standalone tool, and intentionally minimal here. Session transport is [telepty](https://github.com/dmsdc-ai/aigentry-telepty); multi-AI debate is [deliberation](https://github.com/dmsdc-ai/aigentry-deliberation); developer tooling is [devkit](https://github.com/dmsdc-ai/aigentry-devkit).

## Ecosystem

The orchestrator is internal infrastructure that drives the aigentry ecosystem via telepty — it is not published to npm. The published, independently useful modules:

| Module | Package | Version | Role | Maturity |
| --- | --- | --- | --- | --- |
| **telepty** | `@dmsdc-ai/aigentry-telepty` | 0.6.11 | Cross-terminal / cross-machine prompt transport (PTY daemon) | Shipping |
| **brain** | `@dmsdc-ai/aigentry-brain` | 0.2.8 | Persistent cross-session memory (MCP server) | Early |
| **deliberation** | `@dmsdc-ai/aigentry-deliberation` | 0.0.47 | Multi-AI structured debate + synthesis (MCP server) | Early |
| **devkit** | `@dmsdc-ai/aigentry-devkit` | 0.0.22 | Installer/scaffold for the AI dev environment | Early |
| **aterm** | `@dmsdc-ai/aterm` | 0.2.14 | Terminal launcher with native session IPC | Early |
| **orchestrator** | *(unpublished)* | — | Control tower that drives sessions via telepty | Internal |

> Licenses: all MIT except `@dmsdc-ai/aterm` (UNLICENSED).

## License

MIT
