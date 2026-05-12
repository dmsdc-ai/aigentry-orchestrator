---
type: adr
status: accepted
revision: r5+amend-A1A3+r6
date: 2026-05-10
author: aigentry-orchestrator (best-of-both synthesis: claude r1 + codex r1)
scope: ecosystem
decision_type: one-way
tier: T2
trigger: "Q'''-bis grill outcome (2026-05-10) — telepty 0.3.x daemon model has structural defects (issue #14 process conflict, issue #15 embed conflict, V1 RAM ceiling, cross-machine ad-hoc latency) that block V1 (∞ parallelism), V2 (recursive sessions), V3 (terminal-orthogonal UX), and V4 (cross-machine team comm). Daemon-1 → Daemon-0 + per-session supervisor + per-host telepty-relay rewrite is required before Phase 2 feature work."
related:
  - "docs/adr/2026-05-05-telepty-devkit-boundary.md"
  - "docs/adr/2026-05-06-aterm-session-control-opt-3-prime.md"
  - "docs/specs/2026-05-10-v4-cross-mesh-sketch.md"
  - "docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md"
  - "~/projects/aigentry/docs/CONSTITUTION.md (Articles 1, 2, 3, 5, 7, 9, 13, 15, 17)"
  - "~/projects/aigentry-telepty/AGENTS.md"
  - "~/projects/aigentry-orchestrator/docs/rules.md (Rule 16, 24, 26, 29)"
related_tasks: []
unblocks:
  - "telepty issue #14 (process conflict on second daemon spawn)"
  - "telepty issue #15 (embedded library cannot coexist with running daemon)"
  - "V1 ∞ parallelism vision (currently RAM-capped by single shared daemon)"
  - "V2 recursive session vision (parent-child PTY tree)"
  - "V4 cross-mesh team communication (sketch: docs/specs/2026-05-10-v4-cross-mesh-sketch.md)"
status_policy: "proposed → accepted only after preconditions C1–C4 close or are explicitly waived by a successor ADR"
tags:
  - telepty
  - architecture
  - q-prime-bis
  - daemon-zero
  - per-session-supervisor
  - per-host-relay
  - cross-machine
  - tailscale
  - ndjson
  - article-3
  - article-9
  - cleanup-then-feature
  - layer-separation
supersedes: []
reviewers_recommended: [codex, gemini]
revision_history:
  - r1: "2026-05-10 — best-of-both synthesis from claude r1 (829 lines) + codex r1 (1261 lines) parallel drafts. Locked architecture: 3-Layer separation + Q'''-bis core + 31 binding requirements (39 visible acceptance checks) + 19 mandates M22–M40. Synthesis report at docs/reports/2026-05-10-q-prime-bis-adr-synthesis-report.md."
  - r2: "2026-05-10 — E3 amendment integration (per ADR-E3-r1, Option A ≤ 15 MB) + Path C disqualification (Go ConPTY limitation, per bilingual-ops report) + §14 TBD supervisor-language refinement + M28 conditional callout. Verdict: post-r1 ACCEPT_WITH_FIXES (Explore subagent review)."
  - r5_amend_A1A3: "2026-05-12 — A1 wire signal enum extension, A2 error code additions, A3 manifest exit_reason enum, per C3 spec r1 §9.3 mandatory amendments + codex r2 Q6 single-SSOT recommendation. Status remains 'accepted'; this is an additive contract amendment, not an architecture change."
  - r6: "2026-05-12 — Supervisor binary language LOCKED to Rust per Phase 0 C2 (cdylib-in-tokio PoC PASS_WITH_CONDITIONS — 5/5 scenarios, RSS 3.25–3.42 MiB ≪ 15 MB E3) + C4 Path B selection (bilingual ops cost analysis; Path C / Go DISQUALIFIED per §15.2.5 on ConPTY limitation, Go #62708 + #6271). Textual flips at §1.6 / §3 / §5.1 r3 notice / §7.2 r3 notice / §9.1 / §14 (row + count 8→7) / §16.2 / §16.3 / §17.5 (TBD risk → MITIGATED) / §20.1 (decision 11) / §20.2 (count 8→7) / §20.3 / §21.1 r3 notice. Status remains 'accepted'; this is the evidence-based closure of §14 supervisor-language TBD row, not an architecture change. Path A (Node maintain) preserved as documented fallback in §14 / §16.2 but is no longer load-bearing. A1–A3 enums, M22–M40 (including M28 row), 31/39 requirements, §17 14-entry count, B3 trace_id, E3=15MB ceiling, and manifest schema invariants all untouched."
---

# ADR 2026-05-10: telepty L2 Session Architecture (Q'''-bis)

> **Synthesis note**: this ADR is the orchestrator's best-of-both merge of two parallel cross-LLM drafts (claude `*-claude.md` + codex `*-codex.md`, retained as history). Per-section provenance is recorded in the companion synthesis report. Self-criticism (§17) integrates the union of both drafts' adversarial reviews per Constitution Article 13.

## §1 Status, Context, Trigger

### §1.1 Decision summary (8-point lock)

Adopt **telepty L2 supervisor architecture (Q'''-bis)**:

1. Split the stack into **L1 machine**, **L2 session**, **L3 process**, with **terminal app orthogonal**.
2. Remove the shared telepty daemon from the session critical path (Daemon 1 → 0).
3. Run **one per-session supervisor process** per telepty session — owns exactly one PTY.
4. Run **one per-host telepty-relay** only for cross-machine traffic (lazy-spawned, persistent).
5. Use atomic filesystem manifests + per-session structured logs as the discovery and audit backbone.
6. Use OS-native local IPC: UDS on POSIX, Named Pipe on Windows. **TCP loopback rejected.**
7. Use NDJSON (`v:1`) as the wire frame for supervisor and relay traffic, kind-conditional schema.
8. Keep the terminal application orthogonal: aterm / iTerm / kitty / ghostty / tmux are clients or display surfaces, not architectural owners of L2.

### §1.2 Frontmatter summary

- **Status**: **proposed**. Becomes `accepted` only after preconditions **C1–C4** (§14) close or are explicitly waived.
- **Date**: 2026-05-10.
- **Tier**: **T2** — `type=adr × scope=ecosystem × decision_type=one-way` per `references/frontmatter-schema.md`. Threshold = 2 reviewers (recommended: codex + gemini).
- **Decision type**: **one-way**. The L2 protocol surface (NDJSON wire, manifest schema, IPC transport, supervisor lifecycle) binds every downstream consumer (orchestrator, aterm, devkit, brain, dustcraw). Reverting requires cross-repo migration of code, history, and message schema. Bezos one-way principle applies — up-front rigor warranted.
- **Scope**: **ecosystem** — telepty (mechanism owner) + devkit (install/scaffold) + orchestrator (consumer + V4 inbox notification target) + aterm (consumer + UDS SendKey routing) + every CLI session that talks to telepty (claude/codex/gemini wrappers).

### §1.3 Trigger — why this ADR now

The 0.3.x telepty daemon (Node.js single-process, single-shared-bus, single-PID) accreted as a "make it work" prototype while V0 (basic inject/list/attach) was the only requirement. As V1 (∞ parallelism), V2 (recursive sessions), V3 (terminal-orthogonal UX), and V4 (cross-machine team comm) materialized in the 4-axis vision, four production-blocking defects surfaced:

| Defect | Manifestation | Issue / Vision blocker |
|---|---|---|
| **D-1: Process conflict** | Second `telepty daemon` spawn refuses to start (port/PID lock); embedded library cannot start its own daemon when one already runs for the user — blocks `cdylib` embedding. | #14, #15 |
| **D-2: RAM ceiling** | Single shared daemon holds N PTYs in one process — RAM scales superlinearly with PTY count, capping practical N at ~30–50 sessions. | V1 blocker |
| **D-3: Crash blast radius** | Any single PTY parser bug crashes the daemon → all N sessions die simultaneously. | F-class reliability |
| **D-4: Cross-machine ad-hoc** | No first-class cross-machine routing; current code shells out to `ssh ... telepty inject` per call (cold connection cost ~300–800 ms per inject). | V4 blocker, K-class latency |

Direct verification (2026-05-09 cross-machine survey) confirmed the Tailscale + autossh combination handles **L1 (machine reachability)** cleanly; the gap is **L2 (session addressability across the mesh)**. The 0.3.x daemon owns L2 today and is the bottleneck.

The 2026-05-09 survey also documents the user-visible version of the same pressure: cross-machine sessions lose inject reliability during network blips; stale local wrapper metadata leaks into remote session UX; bootstrap prompts and reconnect windows corrupt the target AI CLI; daemon mismatch noise persists when an older bundled daemon owns the port.

### §1.4 Inputs synthesized (binding)

| Input | Path | Frozen ref / Status |
|---|---|---|
| Q'''-bis grill outcomes (locked architecture) | dispatch source-of-truth | `~/.telepty/shared/0b575edfaa0a4ccd03fc4e5f270848e1b1675f14ca71ad1f306a12c5044bf0e5.md` (ingested 2026-05-10) |
| Boundary ADR (telepty/devkit role split) | `docs/adr/2026-05-05-telepty-devkit-boundary.md` | r4 accepted 2026-05-05 (commit `7c5575d`) |
| aterm opt-3-prime ADR (session control parity) | `docs/adr/2026-05-06-aterm-session-control-opt-3-prime.md` | r4 accepted 2026-05-06 |
| V4 cross-mesh sketch (Phase 2 follow-up) | `docs/specs/2026-05-10-v4-cross-mesh-sketch.md` | initial sketch 2026-05-10 |
| Cross-machine survey (Tailscale + autossh) | `docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md` | survey conclusion: Tailscale recommended for L1; SSH ControlMaster ad-hoc rejected for L2 (cold cost) |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 3, 5, 7, 9, 13, 15, 17 | repo HEAD |
| 4-axis vision | `~/projects/aigentry/docs/vision.md` | V1 ∞ / V2 recursive / V3 terminal-orthogonal / V4 cross-machine team |
| Parallel cross-LLM drafts | `*-claude.md`, `*-codex.md` | retained as history; this ADR is the synthesis |

### §1.5 Trace note on requirement count (31 label / 39 visible — under-counted)

The dispatch brief labels the requirements section **"31 Binding Requirements"**. Adding the visible A–K acceptance checks yields **39**:

```
A8 + B4 + C4 + D3 + E4 + F3 + G3 + H3 + I3 + J3 + K1 = 39
```

This ADR **preserves the source label "31 Binding Requirements"** for compatibility with the orchestrator report format, while **enumerating all 39 visible A–K acceptance checks** in §4 so no locked clause is silently dropped. If a future ADR normalizes the count, §4 is the canonical trace table.

### §1.6 What this ADR locks vs. defers

**Locks (HARD):**

- 3-Layer separation (L1 machine / L2 session / L3 process) and the explicit non-coupling of the terminal app dimension to any layer.
- Daemon-1 → Daemon-0 transition: per-session supervisor + per-host telepty-relay model.
- Wire protocol (NDJSON, M37'/M38', schema version 1).
- Local IPC = OS-native (UDS POSIX / Named Pipe Windows). TCP loopback explicitly **rejected** (M22, G2).
- 31 binding requirements (A–K, 39 visible checks) and 19 mandates (M22–M40, with M37'/M38' replacing earlier M37/M38).
- Phase plan (Phase 0 preconditions C1–C4 → Phase 1 protocol+supervisor → Phase 2 OS adapter + V4 → Phase 3 persistent relay → Phase 4 RAM/perf gates).

**Defers (TBD blanks — see §15):**

- **Supervisor binary language**. **LOCKED 2026-05-12 → Rust** per Phase 0 C2 PASS_WITH_CONDITIONS + C4 Path B (see §14 LOCK declaration). Path A (Node maintain) retained as documented fallback only. *(This bullet records the Defers→Lock transition; entry retained in §1.6 for audit-trail continuity.)*
- Migration plan (0.3.x → 1.0) — separate plan ADR (#379), drafted after Phase 1 closure.
- V4 cross-mesh full design — separate Phase 2 ADR; this ADR only locks the M39/M40 surface needed for forward-compat.

---

## §2 Context

### §2.1 Current 0.3.x model

telepty 0.3.x is organized around a shared daemon:

```
CLI -> HTTP/WS -> daemon(:3848) -> session bridge / event bus / REST
```

This worked for early local injection, but the grill identified three structural problems:

1. **Shared lifetime**: one daemon controls many sessions, so daemon version skew, daemon restart, and daemon ownership bugs affect unrelated sessions (D-3 blast radius).
2. **Boundary drift**: a session bridge starts acting like a stateful service, contradicting the "stateless dumb pipe" principle in the telepty/devkit boundary ADR.
3. **V1 parallelism ceiling**: a single daemon becomes the choke point for unbounded session fan-out, especially when sessions span multiple machines, OSes, and embedded hosts (D-2 RAM).

### §2.2 Why Q'''-bis exists (lifetime ownership correction, not a transport tweak)

| Old axis | 0.3.x shape | Q'''-bis shape |
|---|---|---|
| Session lifetime | shared daemon owns many sessions | one supervisor owns one session |
| Cross-machine transport | daemon HTTP reachable or SSH wrapper patterns | relay mediates remote supervisor streams |
| Discovery | daemon in-memory state | atomic filesystem manifests |
| Audit | daemon logs + ad-hoc state | per-session `log.jsonl` |
| Local IPC | HTTP/TCP loopback + mixed fallbacks | OS-native local IPC only |
| Embed | daemon conflict-prone | `cdylib`/`rlib` embedding with conflict isolation |

### §2.3 Four-axis vision pressure

| Vision axis | Pressure on telepty | Q'''-bis answer |
|---|---|---|
| **V1 parallelism** | unlimited parallel AI CLI sessions | per-session supervisors scale linearly and isolate crashes |
| **V2 recursion** | session trees and child agents | `parent_id`, `trace_id`, tree-aware manifest metadata |
| **V3 single interface** | aterm and other terminals as entry points | terminal app remains orthogonal to L2 ownership |
| **V4 agent-mediated cross-mesh** | remote inbox, notifications, reachability | relay + NDJSON protocol stay forward-compatible (M39/M40) |

### §2.4 Layer separation

```
┌─────────────────────────────────────────────────────────────┐
│  L3 process : AI CLI (claude / codex / gemini / shell)      │
│  ─────────────────────────────────────────────────────────  │
│  L2 session : telepty (Q'''-bis — addressable PTY abstr.)   │
│  ─────────────────────────────────────────────────────────  │
│  L1 machine : Tailscale (mesh fabric, stable address)       │
└─────────────────────────────────────────────────────────────┘

Terminal app (aterm / iTerm / kitty / ghostty / Warp / …) is an
orthogonal user choice: not coupled to any of L1/L2/L3.
```

This split means:

- Tailscale is **not** the session layer.
- SSH is **not** the session layer.
- aterm is **not** the session owner.
- tmux is **not** the telepty contract.
- AI CLI process state is **L3**, not L2.
- telepty owns the **L2 PTY abstraction** and routing contracts only.

### §2.5 Boundary ADR compatibility

ADR `2026-05-05-telepty-devkit-boundary.md` states that telepty owns transport/runtime primitives and protocol semantics, while devkit owns disk-side content and per-CLI integration. Q'''-bis follows that boundary:

- telepty owns session supervisors, relay, IPC, manifests, logs, and wire protocol;
- devkit may install hooks and scaffold files (no change);
- aterm remains a first-class UI endpoint;
- orchestrator dispatches and coordinates;
- none of those components own telepty's L2 lifetime.

### §2.6 Cross-machine survey compatibility

The 2026-05-09 survey recommended:

```
Tailscale raw SSH over MagicDNS + autossh + remote tmux
```

Q'''-bis keeps the L1 winning idea and replaces the L2/L3 overload:

- **Tailscale** remains the stable machine fabric.
- **SSH** remains the remote authenticated stream primitive.
- **relay** becomes the long-lived per-host telepty endpoint.
- **supervisor** owns the remote PTY directly.
- **tmux** may still be useful for human fallback, but is **no longer the L2 contract**.

---

## §3 Decision

### §3.1 Adopt Q'''-bis (HARD)

```
local CLI / embedder
  -> local IPC (UDS / Named Pipe)
  -> per-session supervisor
  -> PTY
  -> AI CLI process

local CLI
  -> SSH stream over Tailscale
  -> per-host telepty-relay
  -> local IPC on remote host
  -> per-session supervisor
  -> PTY
  -> AI CLI process
```

### §3.2 Remove the shared daemon (Daemon 1 → 0)

The daemon count moves from **1 to 0** in the session critical path.

Binding consequences:

- no singleton daemon owns all sessions;
- no port 3848 listener is required by default;
- no daemon PID discovery is required to inject into a live session;
- daemon version mismatch cannot block unrelated sessions;
- crash isolation is per-session, not per-host.

### §3.3 Per-session supervisor

Each telepty session has exactly one supervisor process.

| Responsibility | Owner |
|---|---|
| Allocate and own PTY (master+slave) | supervisor |
| Spawn L3 process | supervisor |
| Inject bytes / structured input | supervisor |
| Emit output frames | supervisor |
| Resize PTY | supervisor |
| Send signals | supervisor |
| Write manifest atomically | supervisor |
| Append structured log | supervisor |
| Drain in-flight ops on termination | supervisor |

**Non-responsibilities**: it does not render UI; it does not store long-term memory; it does not perform AI triage in Phase 1; it does not mutate devkit/project scaffolding files.

The brutal-honest core: a supervisor per session **trades RAM for almost everything else** — process isolation, crash containment, cdylib embedding, single-thread tokio runtime per session, jemalloc tuning per session, zero shared mutable state across sessions. The trade is acceptable because (a) modern hosts have 16–64 GB RAM, (b) Rust supervisors target 5–8 MB each, (c) RAM-limited pathological N is bounded by `ulimit -u` and disk, not by telepty design (M29). See §10 RAM honesty and §17 self-criticism.

### §3.4 Per-host relay (cross-machine only)

For cross-machine operations, each host runs **one persistent `telepty-relay`**.

| Responsibility | Phase |
|---|---|
| accept authenticated SSH stream from another trusted host | 3 |
| route frames to local supervisors by `sid` | 3 |
| multiplex multiple remote sessions over one relay process | 3 |
| enforce V4 reachability policy (M40) | 2+ |
| store V4 inbox messages after contact verification | 2+ |
| notify orchestrator via single-line inbox inject (M39) | 2+ |

**Non-responsibilities**: it does not own PTYs; it does not replace a supervisor; it does not store-and-forward messages while a receiver is offline; it does not become a shared daemon for local sessions.

Cross-machine routing requires (a) connection multiplexing (avoid per-inject SSH cold-start ~300–800 ms), (b) stable peer discovery (Tailscale handle + relay manifest), (c) authentication boundary control (Phase 1 = SSH key, Phase 2 = HMAC token reserved). A persistent per-host relay amortizes the connection cost across all injects in a session lifetime; SSH ControlMaster was rejected (M23, see §9.4) because its socket lifecycle / crash semantics do not match the supervisor lifecycle.

### §3.5 Filesystem manifest discovery

Each session writes:

```
~/.telepty/sessions/<id>/manifest.json
~/.telepty/sessions/<id>/log.jsonl
```

Manifest writes are atomic:

```
write manifest.json.tmp
fsync file
rename manifest.json.tmp -> manifest.json
fsync directory where supported
```

The manifest schema version is `schema_version: 1`.

### §3.6 Structured per-session log

`log.jsonl` is append-only structured NDJSON. Minimum event classes:

| Event | Required fields |
|---|---|
| `spawn_attempt` | `ts`, `sid`, `attempt`, `argv_hash` |
| `spawn_ready` | `ts`, `sid`, `pid`, `pty`, `cwd` |
| `inject` | `ts`, `sid`, `trace_id`, `op_id`, `bytes`, `idempotency_key` |
| `output` | `ts`, `sid`, `seq`, `bytes` |
| `resize` | `ts`, `sid`, `cols`, `rows` |
| `signal` | `ts`, `sid`, `signal` |
| `delete` | `ts`, `sid`, `reason` |
| `error` | `ts`, `sid`, `code`, `message` |
| `shutdown_drain` | `ts`, `sid`, `in_flight`, `completed` |

The log is **not** the source of discovery. The manifest is the source of discovery. The log is the source of audit and recovery explanation.

### §3.7 OS-native local IPC

| Platform | IPC |
|---|---|
| macOS | Unix Domain Socket |
| Linux | Unix Domain Socket |
| WSL | Unix Domain Socket inside WSL boundary |
| Windows native | Named Pipe with owner ACL |

Binding rejection:

- no TCP loopback listener in Phase 1;
- no local HTTP server as default IPC surface;
- no cross-platform abstraction that secretly degrades to localhost TCP.

### §3.8 NDJSON wire frame (M37'/M38')

Phase 1 frame format is line-delimited JSON, UTF-8:

```json
{"v":1,"sid":"remote-codex","kind":"inject","data":"task X\n","trace_id":"<W3C-trace-context>"}
{"v":1,"sid":"remote-gemini","kind":"output","data":"hello world\n","trace_id":"<W3C-trace-context>"}
{"v":1,"sid":"remote-claude","kind":"resize","cols":120,"rows":40}
```

`kind` enum: `inject / output / spawn / delete / resize / signal / ping / pong / error`.

Frame rules:

- `v` is required and starts at `1`;
- `sid` is required for session-scoped frames;
- `kind` is required;
- `data` is required only for data-carrying frame kinds;
- kind-conditional fields are explicit (e.g. `resize` requires `cols` and `rows`);
- receivers must fail-closed on unknown required fields for a known kind;
- receivers may ignore unknown optional fields for forward compatibility.

### §3.9 Auth Phase 1 (intentionally small)

| Surface | Auth |
|---|---|
| POSIX local IPC | filesystem permission `0600` on socket path and parent session dir |
| Windows local IPC | Named Pipe owner ACL |
| Cross-machine | existing OpenSSH key auth over Tailscale-reachable address |
| telepty-level token | **none in Phase 1** |

Phase 2+ may add HMAC token authentication for inject operations (M11 reserve, B4 wire field). That is explicitly **not** a Phase 1 requirement.

### §3.10 Single binary modes

Ship one binary with multiple modes:

```
telepty supervisor ...
telepty relay ...
telepty cli ...
telepty embed ...
```

Supervisor crate shape:

```toml
crate-type = ["cdylib", "rlib"]
```

This supports both standalone process mode and embedded host mode without inventing a second implementation. **Language LOCKED to Rust 2026-05-12** per Phase 0 C2 PASS_WITH_CONDITIONS + C4 Path B (see §14 LOCK declaration).

---

## §4 Constraints — 31 binding requirements (39 visible acceptance checks)

The 31 requirements below are the binding contract. Each requirement has (a) a measurement criterion or test gate, and (b) a rejection-on-violation rule. Items A–J are derived from the grill; item **K is NEW** (cross-machine inject latency budget — locked in this ADR for the first time).

### §4.A Functional core (8)

| ID | Requirement | Measurement / Gate |
|---|---|---|
| A1 | **PTY ownership**: one supervisor process owns exactly one PTY (master+slave) | `lsof -p <pid>` → exactly 1 ptmx fd |
| A2 | **Inject**: write data to PTY stdin, with idempotency key support | `telepty inject <id> "x"` → next `output` frame contains `"x"` |
| A3 | **Output streaming**: PTY output → NDJSON `kind:"output"` frames | client subscription receives frames within 50 ms of PTY write |
| A4 | **Signal**: SIGINT/SIGTERM/SIGHUP delivery to PTY child | `telepty signal <id> SIGINT` → child receives signal (verify via `wait()` exit code) |
| A5 | **Detach / Reattach**: client may disconnect; supervisor persists; reconnect resumes | client kill → supervisor stays alive; new connect resumes output stream from log offset |
| A6 | **Stable session ID**: assigned at spawn, persisted in manifest, immutable | manifest `id` field present; no rewrite on reattach |
| A7 | **List**: enumerate live sessions on this host | `telepty list --json` returns all sessions whose manifest exists and supervisor is alive |
| A8 | **Delete**: graceful supervisor termination + manifest cleanup | `telepty delete <id>` → SIGTERM supervisor → drain in-flight → unlink manifest |

### §4.B Identity / Tracing (4)

| ID | Requirement | Measurement |
|---|---|---|
| B1 | **User × machine identity**: every session manifest records `user`, `machine_id`, `tailscale_handle` (if mesh-joined) | manifest schema check |
| B2 | **Parent ID**: V2 recursive sessions record `parent_id` (null for top-level) | manifest schema check; V2 session creation populates `parent_id` from caller |
| B3 | **Trace ID**: every inject and output carries `trace_id` (UUID v7) for cross-session causality | NDJSON `trace_id` field present on inject/output kinds |
| B4 | **Inject auth (Phase 2 reserve)**: HMAC token surface reserved in wire schema (`auth_token` optional field), but not enforced in Phase 1 | Phase 1: field unused. Phase 2: M11 follow-up enforces |

### §4.C Cross-machine + Platform (4)

| ID | Requirement | Measurement |
|---|---|---|
| C1 | **UDS + SSH-as-IPC**: cross-machine relay tunnels NDJSON over SSH stream (existing OpenSSH transport) | integration test: relay-A → SSH → relay-B → supervisor delivers inject |
| C2 | **Tailscale L1**: relay discovery via Tailscale handle + manifest mirror | relay startup resolves `<user>@<machine>.<tailnet>.ts.net` via tailscaled |
| C3 | **Linux / macOS / WSL parity**: identical NDJSON wire, identical UDS path layout, identical manifest schema | per-OS adapter test (M25 contract test) green on Linux + macOS + WSL |
| C4 | **Windows native**: Named Pipe transport (no WSL dependency); identical wire/manifest semantics | Windows native build runs supervisor + CLI without WSL; `\\.\pipe\telepty-<id>` named pipe present |

### §4.D Embedded (3)

| ID | Requirement | Measurement |
|---|---|---|
| D1 | **Library API**: supervisor mode is reachable via `cdylib` symbols, not only as standalone process | C API exposes `telepty_spawn / telepty_inject / telepty_close`; smoke test from a host process |
| D2 | **Daemon-less embed**: embedding host (orchestrator app, brain, etc.) does not require any external daemon to coexist | cdylib host runs in PID P; no other telepty PID required |
| D3 | **Conflict isolation (issue #15 closure)**: multiple cdylib embeds in different host processes do not collide | run host-A and host-B simultaneously, both spawn 1 session; no UDS / manifest collision |

### §4.E Performance (4)

| ID | Requirement | Measurement |
|---|---|---|
| E1 | **Local inject latency**: < 1 ms (median) on the same host | microbenchmark: 10k injects, p50 < 1 ms, p99 < 5 ms |
| E2 | **Cold start**: supervisor spawn → first inject acceptance < 500 ms | E2E test: `telepty spawn` returns; immediate inject succeeds within 500 ms |
| E3 | **RAM**: ≤ 15 MB RSS per idle supervisor (per ADR-E3-r1, jemalloc tuned, single-thread tokio) | post-spawn `ps -o rss` ≤ 15 MB. Verified by C1 amendment ADR (Option A — 2026-05-10). |
| E4 | **Idle CPU**: < 0.1 % per supervisor when PTY is silent | `top -p <pid>` over 60 s window |

### §4.F Reliability (3)

| ID | Requirement | Measurement |
|---|---|---|
| F1 | **Crash isolation**: supervisor crash kills only its own session, not others | `kill -9 supervisor-A`; supervisor-B/C continue serving |
| F2 | **Idempotent inject**: a duplicate inject (same `idempotency_key`) is detected and acknowledged exactly once | replay test: same NDJSON frame submitted twice → child sees data once |
| F3 | **Atomic discovery**: manifest writes use `rename()` to avoid partial-read races | concurrent reader observes either old-complete or new-complete manifest, never partial |

### §4.G Security (3)

| ID | Requirement | Measurement |
|---|---|---|
| G1 | **POSIX permission**: UDS socket file is `0600` (owner-only). Manifest dir `~/.telepty/sessions/` is `0700` | `stat` check after spawn |
| G2 | **No network listener by default**: supervisor binds only to UDS / Named Pipe; no TCP loopback, no `0.0.0.0` listener | `ss -tlnp` / `netstat -an` shows no telepty TCP listener post-spawn |
| G3 | **Audit trail**: every inject/signal/delete writes a `log.jsonl` entry with `(ts, kind, actor, trace_id)` | log inspection after operations |

### §4.H Operability (3)

| ID | Requirement | Measurement |
|---|---|---|
| H1 | **Self-supervision (crash detection + audit replay; not live PTY recovery)**: supervisor crash → launchd (macOS) / systemd-user (Linux) / Windows Service spawns a fresh supervisor; manifest status flips to `died` then `ready`; log offset preserved | crash test: `kill -9` supervisor → detection within 5 s, manifest status updated, `log.jsonl` artifact intact and replayable. **Live PTY recovery is not in scope** — kill of supervisor is kill of PTY master FD per 1-process model (§9.5); child CLI process exits with the supervisor; conversation state lives in the child CLI, not telepty. Restart yields a fresh PTY + fresh child invocation under the same session `id` (manifest/log preserved as observability artifacts) |
| H2 | **Disk policy**: per-session log rotation default 100 MB; old segments compressed; configurable cap | log file size bounded; rotation observed on threshold |
| H3 | **Single binary**: one shipped artifact `telepty` switches modes via subcommand or argv0 (`telepty-supervisor`, `telepty-relay`, etc.) | `file telepty` is one binary; mode switch test |

### §4.I Composability for V1 + V2 + V4 (3)

| ID | Requirement | Measurement |
|---|---|---|
| I1 | **Tree-aware**: V2 recursive parent→child relationships expressed via `parent_id` and queryable through `telepty list --tree` | tree query returns hierarchy |
| I2 | **Cost / quota hooks**: per-session metadata fields (`cost_budget`, `quota_class`) reserved in manifest for downstream gating | manifest schema includes optional fields |
| I3 | **V4 forward-compat**: M39 (inbox notification format), M40 (binary reachability), and the V4 sketch consume Q'''-bis surfaces with **zero new components** | V4 ADR (Phase 2) does not introduce new daemon/relay processes |

### §4.J Compatibility (3)

| ID | Requirement | Measurement |
|---|---|---|
| J1 | **Wire protocol versioned**: `v: <int>` on every NDJSON frame; mismatched versions reject with `kind:"error"` | mismatch test |
| J2 | **Manifest schema versioned**: `schema_version` field; consumers gracefully reject unknown versions | gracefully degrade |
| J3 | **0.3.x backward-compat**: 0.3.x clients can talk to 1.0 supervisor for the deprecated subset (inject/list/output) during the migration window (separate ADR #379 details) | bridge layer in 1.0 supervisor honors 0.3.x wire for `kind ∈ {inject, output, list}` |

### §4.K (NEW) Cross-machine inject latency (1)

| ID | Requirement | Measurement |
|---|---|---|
| K1 | **Cross-machine inject RTT**: median ≤ 20 ms, p99 < 100 ms, on Tailscale LAN/regional links | E2E test: relay-A → relay-B → supervisor → ack frame; latency-budget breakdown ≤ 20 ms = (Tailscale RTT 5–15 ms) + (relay framing < 2 ms) + (supervisor dispatch < 1 ms) |

K1 is **new in this ADR**. Justification: V4 inbox notifications and orchestrator-mediated team comm (notification within one turn boundary) require a hard latency cap to be a usable interaction primitive. Without K1, V4 UX degrades from "team chat-like" to "delayed batch" — the surveyed-rejected design.

### §4 acceptance gates by category

| Category | Gate |
|---|---|
| Functional core | A1–A8 pass contract tests on macOS and Linux before Phase 1 acceptance |
| Identity / tracing | B1–B3 present in manifest/log; **M37'/M38' contract test rejects `inject`/`output` frames lacking `trace_id` (B3 enforcement)**; B4 reserved without shipping token |
| Cross-machine / platform | C1–C4 adapter tests exist before Phase 2 acceptance |
| Embedded | D1–D3 proven by cdylib-in-host PoC before Phase 2 entry |
| Performance | E1–E4 measured on reference Mac and Linux hosts |
| Reliability | F1–F3 covered by crash / duplicate / atomicity tests |
| Security | G1–G3 covered by permission and audit tests |
| Operability | H1–H3 documented in install + service templates |
| Composability | I1–I3 validated against V1/V2/V4 sketches |
| Compatibility | J1–J3 validated against migration ADR #379 |
| Cross-machine latency | K1 measured with relay over Tailscale + SSH |

---

## §5 Mandates M22–M40

Mandates are **derived rules** that constrain implementation while leaving room for tactical choice. Each mandate cites the requirement(s) it serves and the alternative it rejects. M37/M38 from earlier drafts are superseded by M37'/M38' (NDJSON wire, kind-conditional fields).

### §5.1 Mandate roster

> **Rust-conditional mandate notice (r3; closed r6 2026-05-12)**: M24 (single-thread tokio + jemalloc), M27 (sccache + cargo workspace + selective LTO), M28 (`cdylib + rlib`), and M31 (jemalloc tuning) **presuppose a Rust supervisor** — **LOCKED per Phase 0 C2 PASS_WITH_CONDITIONS + C4 Path B selection (see §14)**. The historical contingency below is retained as audit context; it is no longer load-bearing. *(Historical contingency, r3)*: had C2 PoC failed, Path A (Node 0.3.x maintained) would have replaced those mandates with their Node-equivalent ops (Node single-thread event loop, esbuild/turbopack equivalents, no jemalloc surface) per the bilingual-ops report; M28 row encodes this contingency explicitly; M24/M27/M31 would have been voided in lockstep with C2 fail. The schema/wire/IPC mandates (M22, M23, M25, M37', M38', etc.) are language-neutral and survive either path.

| Mandate | Binding decision | Serves | Why the rejected alternative is wrong |
|---|---|---|---|
| **M22** | OS-native local IPC: UDS POSIX, Named Pipe Windows; **not TCP loopback** | G2, C3/C4, E1 | TCP loopback (a) violates G2 because port-bind is observable to scanners and policy auditors; (b) violates M16 / Article 9 because port allocation conflicts with multiple supervisor instances; (c) loses POSIX file permission semantics — UDS naturally enforces `0600` while TCP loopback opens to all local users |
| **M23** | Persistent telepty-relay per host; **not SSH ControlMaster** | K1, F1, I3 | ControlMaster (a) socket lifecycle is owned by openssh, not telepty — supervisor crash recovery cannot atomically restart the multiplexed connection; (b) no application-level framing — every inject still pays one ssh-channel-allocation roundtrip; (c) ambiguous EOF semantics caused intermittent inject losses in 0.3.x; (d) no Windows-native parity |
| **M24** | Single-process supervisor, single-thread tokio + jemalloc | E3, E4, F1, F2 | PTY I/O is intrinsically serial (one ptmx fd); multi-thread tokio doubles per-worker stack RAM (≈ 2 MB × 4 = 8 MB overhead) without throughput gain. The session is the parallelism unit, not the thread |
| **M25** | Protocol contract test is binding; per-OS adapter implementation is free | J1, J2, C3, C4 | 0.3.x lacked a contract test, so each platform fork drifted; 1.0 enforces wire equality before allowing platform feature work |
| **M26** | Cross-machine inject latency budget: 10–20 ms RTT + framing/dispatch | K1 | Prevents relay from becoming an unmeasured queueing layer |
| **M27** | sccache + cargo workspace caching + selective LTO | dev ergonomics | Rust full-tree LTO doubled CI time in early prototypes; this mandate fences the cost |
| **M28** | Rust supervisor `crate-type = ["cdylib", "rlib"]` | D1, D2, D3 | One source tree, two artifacts. **Conditional**: M28 presupposes Rust supervisor. If C2 PoC FAILS, M28 voided + replaced by Path A maintenance plan (Node 0.3.x). See §17.5 + bilingual-ops report. (Path C / Go disqualified per §15.2.5 — ConPTY limitation.) |
| **M29** | Remove N=100 cap; allow as many sessions as infrastructure permits | V1 ∞ | An arbitrary cap becomes a product constraint before evidence exists. The practical ceiling is host `ulimit -u`, fd limit, RAM, and disk |
| **M30** | First-spawn ulimit auto-set or clear guidance (boundary-aware: this is **first-run check**, not install-time hook) | M29 operability | A per-process architecture must surface fd/process budget early. Boundary-clean (per §17.7): "first-spawn check" is mechanism, not content |
| **M31** | Per-supervisor jemalloc tuning: `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0` | E3, E4 | jemalloc default decay (10 s+) holds RAM high after burst PTY output; aggressive decay returns RSS to floor within ms — required to make E3 attainable |
| **M32** | Idle timeout default = unlimited (user configurable) | V1, F1 | Long-lived AI sessions must not disappear unexpectedly |
| **M33** | Spawn graceful: 3 retries × exponential backoff (100 ms, 400 ms, 1.6 s) | F-class reliability | Handles transient install/upgrade contention without silent loss |
| **M34** | Crash detection: launchd `KeepAlive` / systemd-user `Restart=on-failure` / Windows Service auto-restart spawns a new supervisor process. **Manifest + `log.jsonl` artifacts preserved** (state recovery is observability/audit-level only, **not** conversation-level — live PTY cannot be recovered in the 1-process model; see §9.5 / §17 r3 closure). Restart = fresh PTY + fresh child invocation under the same session `id` | H1, F1 | Supervisor failure has a first-class **detection + audit-replay** path; the design owns the trade-off rather than promising impossible same-PTY recovery |
| **M35** | Discovery graceful: manifest cache → SSH config → Tailscale `tailscale status` cache | A7, C2, K1 | `list` works even when one discovery source is stale |
| **M36** | All termination graceful drain on SIGTERM (flush log, ack in-flight, write final manifest entry, exit). SIGKILL bypasses (intentional) | F2, G3 | Default termination uses SIGTERM — in-flight inject/output finish or log explicit failure |
| **M37'** | Wire frame = NDJSON, line-delimited UTF-8 JSON | J1, J2 | Replaces M37. NDJSON over msgpack/protobuf because: (a) `tail -f log.jsonl \| jq` debuggability; (b) AI CLIs already produce JSON; (c) framing complexity is one `splitlines()`; (d) ~2× byte overhead is irrelevant for PTY traffic (typical << 1 MB/s) |
| **M38'** | Frame schema versioned (`v:1`), kind-conditional fields | J1, J2 | Replaces M38. Adding `kind:"resize" {cols, rows}` does not require base schema change — older parsers ignore unknown kinds with `kind:"error" reason:"unknown_kind"` |
| **M39** | V4 inbox notification = single channel, file-based source of truth. Format: `[INBOX from <alias>] <≤ 50-char title>`. Turn-end debounced + batched. Configurable disable | I3, V4 sketch §V4-6 | Anti-rule: no per-session pop-ups, no shell hooks, no terminal beeps — orchestrator is the single notification destination |
| **M40** | V4 reachability is binary: `(Tailscale up) AND (SSH reachable) AND (relay running)`. If false, sender immediately rejects. **No mailbox / store-and-forward** | I3, V4 sketch §V4-12 | Queue semantics expand the security perimeter (persistent inter-user content storage) and the UX surface (delivery uncertainty). Phase 3+ may revisit if binary policy proves too brittle |

### §5.2 Mandate interactions (load-bearing pairs)

- **M22 + M23** — local boundary pair. M22 rejects local TCP listener; M23 puts SSH and relay at the **machine** boundary, not on localhost.
- **M29 + M31** — scaling pair. M29 refuses an arbitrary session cap; M31 admits the cost and forces per-supervisor memory hygiene.
- **M37' + M38'** — protocol pair. M37' picks the frame transport (NDJSON); M38' keeps the schema additively evolvable.
- **M39 + M40** — V4 pair. M39 defines how a reachable receiver is notified; M40 rejects offline queueing as a Phase 2 concept.

---

## §6 Wire Protocol — NDJSON (M37'/M38' detail)

### §6.1 Frame envelope

Every frame has this base envelope:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | wire schema version |
| `sid` | string | session-scoped frames | session ID matching `manifest.id` |
| `kind` | string enum | yes | frame kind |
| `trace_id` | string | **required (Phase 1) for `inject` and `output`** per B3; optional for other kinds | UUID v7 (or W3C trace-context) operation trace |
| `op_id` | string | optional Phase 1, recommended | operation ID |
| `ts` | string | optional | sender RFC 3339 timestamp |
| `data` | string | kind-dependent | payload for inject/output/error |

### §6.2 Kind-conditional fields

| kind | Required | Optional |
|---|---|---|
| `inject` | `sid`, `data` (UTF-8), **`trace_id`** (per B3) | `auth_token` (B4 reserve), `idempotency_key` (default = `op_id`/`trace_id`), `from` |
| `output` | `sid`, `data`, **`trace_id`** (per B3, propagated from triggering inject or freshly minted for unsolicited PTY emissions) | `seq` (monotonic integer, log offset) |
| `spawn` | `sid`, `argv` (or `profile`), `cwd` | `env_policy`, `parent_id` (B2), `cost_budget` (I2) |
| `delete` | `sid` | `reason`, `force` (default false) |
| `resize` | `sid`, `cols` (int), `rows` (int) | — |
| `signal` | `sid`, `signal` (enum: see §6.2.1 — extended A1) | — |
| `ping` | — | `ts` |
| `pong` | — | `rtt_ms`, `ts` |
| `error` | `code`, `data` (human-readable message) | `frame_ref` (offending line), `sid` if applicable |

#### §6.2.1 `signal` enum (A1 amendment — 2026-05-12)

The `signal` field on `kind:"signal"` and (informationally) on `kind:"shutdown_drain"` log events uses this enum. Per SPEC-C3-r1 §1.3 / §2.2 / §9.3 A1 (codex r2 Q6 single-SSOT closure):

| Value | Platform | Meaning |
|---|---|---|
| `"SIGINT"` | POSIX-only | interactive interrupt; on Windows the supervisor returns `kind:"error" code:"ERR_BAD_FRAME" data:"signal_not_supported_on_windows"` (no group-targeted CTRL_C per Microsoft docs) |
| `"SIGTERM"` | POSIX | graceful termination request; Windows observable parity = `CTRL_BREAK_EVENT` (handler-based, not a POSIX signal) |
| `"SIGHUP"` | POSIX | controlling-terminal hangup; emitted by kernel when PTY master closes |
| `"SIGKILL"` | POSIX | uncatchable forced termination; Windows observable parity = `JOB_TERMINATE` |
| `"JOB_TERMINATE"` | Windows-only | result of `TerminateJobObject(job_handle, 1)` cascade; observable equivalent of POSIX `kill(-pgid, SIGKILL)` |
| `"CTRL_BREAK_EVENT"` | Windows-only | result of `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, console_group_id)`; observable equivalent of POSIX SIGTERM-to-pgrp |

**Cross-OS rule**: this is **observable parity, not primitive equivalence** (per SPEC-C3-r1 §3.2.3 / §3.5). The wire `signal` value names the supervisor-observed mechanism; the orchestrator MUST treat the POSIX-side and Windows-side values as parity pairs (`SIGTERM` ↔ `CTRL_BREAK_EVENT`; `SIGKILL` ↔ `JOB_TERMINATE`) when comparing kill outcomes across platforms.

**Receiver behavior**: receivers MUST fail-closed on `signal` values outside this enum (`kind:"error" code:"ERR_BAD_FRAME"`).

### §6.3 Worked examples

```
{"v":1,"sid":"remote-codex","kind":"inject","data":"task X\n","trace_id":"019..."}
{"v":1,"sid":"remote-gemini","kind":"output","data":"hello world\n","seq":4271,"trace_id":"019..."}
{"v":1,"sid":"remote-claude","kind":"resize","cols":120,"rows":40}
{"v":1,"sid":"remote-claude","kind":"signal","signal":"SIGINT"}
{"v":1,"kind":"error","code":"ERR_BAD_FRAME","data":"unknown_kind","frame_ref":"<offending-line>"}
```

### §6.4 Error codes (Phase 1 minimal set + A2 kill-gate extensions per SPEC-C3-r1)

| Code | Meaning |
|---|---|
| `ERR_UNKNOWN_SESSION` | no manifest or live supervisor for `sid` |
| `ERR_BAD_FRAME` | JSON parse / schema validation failure |
| `ERR_UNSUPPORTED_VERSION` | frame `v` not supported by receiver |
| `ERR_PERMISSION_DENIED` | IPC permission / auth failure |
| `ERR_NOT_REACHABLE` | M40 binary reachability fail (remote relay/supervisor unreachable) |
| `ERR_DUPLICATE_OP` | idempotent replay detected and suppressed |
| `ERR_SPAWN_FAILED` | spawn failed after retry budget (M33) |
| `ERR_SHUTTING_DOWN` | supervisor draining; rejects new work |
| `ERR_UNKNOWN_KIND` | kind not in enum (graceful degrade; sender retries with v↓ if applicable) |
| `ERR_UNKILLABLE_CHILD` | child still alive after `child_reap_timeout_ms` past forced kill (POSIX D-state / Windows IRP-stuck) — see SPEC-C3-r1 §7.B / §7.C (A2 amendment) |
| `ERR_PARENT_GONE` | orchestrator/relay disappearance detected past `parent_death_grace_ms` heartbeat budget — supervisor logs and continues per §1.4 of SPEC-C3-r1 (A2 amendment) |
| `ERR_SUPERVISOR_GONE` | observer-side detection: stale-supervisor pid no longer running for a manifest that still claims `status:"ready"` / `"draining"` — SPEC-C3-r1 §1.5 (A2 amendment) |
| `ERR_MANIFEST_WRITE_FAIL` | atomic manifest write failed (ENOSPC, fs error, permission) — SPEC-C3-r1 §7.F (A2 amendment) |
| `ERR_ESCAPED_DESCENDANT` | advisory warn: pgrp/Job Object empty but external descendants observable via out-of-band marker — SPEC-C3-r1 §6.7 (A2 amendment, optional emission) |
| `ERR_PGRP_LIVE_AFTER_KILL` | advisory warn: pgrp non-empty after expected kill window, before escalation — SPEC-C3-r1 §4.1.2 (A2 amendment, optional emission) |

### §6.5 Idempotency walkthrough

```json
{"v":1,"sid":"remote-codex","kind":"inject","op_id":"01HX...","idempotency_key":"sha256:...","trace_id":"<W3C-trace-context>","data":"task X\n"}
```

Supervisor behavior:

1. If the key is **new**, apply inject and append log event.
2. If the key is **repeated and already completed**, return success with duplicate marker.
3. If the key is **repeated and in-flight**, return in-flight state or wait per caller policy.
4. If the key **repeats with different payload hash**, reject as `ERR_BAD_FRAME`.

### §6.6 Backpressure policy

- **Output frames**: bounded ring buffer (default 64 MB per session). On overflow, oldest frames drop and a single `kind:"error" code:"ERR_DROPPED" count:<N>` frame is emitted.
- **Inject frames**: synchronous ack; on slow PTY, ack is delayed (no buffer growth on supervisor side).

### §6.7 Backward compatibility surface

The Phase 1 CLI may preserve existing user-facing commands:

```
telepty list
telepty inject <id> "message"
telepty attach <id>
telepty read-screen <id>
telepty enter <id>
```

Implementation behind those commands changes from daemon HTTP/WS to manifest discovery + supervisor IPC. Any compatibility shim that still speaks 0.3.x must be explicitly marked as migration code and removed/retired by migration ADR #379.

---

## §7 Manifest and Disk Layout

### §7.1 Directory layout

```
~/.telepty/
  sessions/
    <sid>/
      manifest.json
      log.jsonl
      supervisor.sock        # POSIX only
      supervisor.pipe.name   # Windows metadata only, if needed
      pid
      lock
  relay/
    manifest.json
    log.jsonl
  inbox/
    <msg-id>.json            # V4 Phase 2+
  contacts/
    <alias>.json             # V4 Phase 2+ (per V4 sketch §V4-3)
```

### §7.2 Manifest schema version 1

> **Conditional example notice (r3; resolved r6 2026-05-12)**: the example below uses the **Rust supervisor** path — **LOCKED per §14 (C2 PASS + C4 Path B)**. Historical contingency *(r3, retained for audit)*: had C2 PoC failed, Path A (Node 0.3.x maintained) would have kept the existing 0.3.x manifest format and `"lang": "rust"` would have read `"lang": "node"` — the surrounding schema invariants in §7.3 hold for either implementation. See §17.5 (closure note) and §15.2.5 (Path C / Go disqualification, ConPTY).

Illustrative:

```json
{
  "schema_version": 1,
  "id": "01HX...",
  "user": "duckyoungkim",
  "machine_id": "macbook",
  "host": "macbook.tailnet.ts.net",
  "tailscale_handle": "duckyoungkim@macbook.tail-scale-net.ts.net",
  "pid": 12345,
  "created_at": "2026-05-10T01:30:00Z",
  "updated_at": "2026-05-10T01:30:01Z",
  "cmd": ["claude"],
  "cwd": "/Users/duckyoungkim/projects/aigentry-orchestrator",
  "env": {"TELEPTY_SESSION_ID": "01HX..."},
  "argv_hash": "sha256:...",
  "parent_id": null,
  "trace_id": "01HX...",
  "ipc": {
    "kind": "uds",
    "path": "~/.telepty/sessions/01HX.../supervisor.sock"
  },
  "supervisor": {
    "pid": 12345,
    "binary_version": "1.0.0",
    "lang": "rust"
  },
  "status": "ready",
  "protocol": { "wire_version": 1 },
  "cost_budget": null,
  "quota_class": null
}
```

### §7.3 Manifest invariants

- `schema_version` is mandatory.
- `id` (or `sid`) must match the directory basename.
- `ipc.kind` is `uds` or `named_pipe`.
- `status` ∈ {`spawning`, `ready`, `draining`, `stopped`, `error`}.
- `exit_reason` (A3 amendment — 2026-05-12; **only present on tombstoned manifests** per SPEC-C3-r1 §6.3.2): enum ∈ {`"normal"`, `"signaled"`, `"killed"`, `"crashed"`, `"unkillable"`}. Clean exits **unlink** the manifest per A8 (no tombstone, no `exit_reason` written); only `crashed` and `unkillable` retain a tombstone manifest. **`"orphan"` is NOT a terminal `exit_reason`** — orphaned supervisors stay `status:"ready"` per §1.4 of SPEC-C3-r1 and never write `exit_reason`. Audit detail (`exit_signal`, `exit_code`, `escalated`) lives in `log.jsonl` per SPEC-C3-r1 §6.3.1, NOT in the manifest.
- Partial writes are invalid by construction — readers only read `manifest.json` after atomic rename.
- Stale manifests are detected by validating `pid`, IPC reachability, and optional heartbeat timestamp.

### §7.4 Disk policy (Phase 1 defaults — configurable)

| File | Default retention |
|---|---|
| `manifest.json` | while session exists; tombstone optional after delete |
| `log.jsonl` | retained until explicit cleanup or size policy trigger (default rotate at 100 MB, compress old segments) |
| output data in logs | bounded or redacted per audit policy |
| inbox files | V4 source of truth; separate retention policy |

Disk policy must be configurable. **Default behavior must not surprise users by deleting live session state.**

---

## §8 Relay Topology and Lifecycle

### §8.1 Topology — T1 per-host single relay

| Item | Decision |
|---|---|
| Relay count | one relay per host (per local user) |
| Multi-user host | T1 default; T2 (per-user-per-host) escalation option later |
| Spawn | lazy on first cross-machine inject |
| Idle timeout | unlimited by default, configurable (L2c) |
| Restart | launchd / systemd-user / Windows Service auto-restart with state recovery (L3a) |
| Discovery | manifest cache → SSH config → Tailscale `tailscale status` cache (L4a) |

### §8.2 Lifecycle (L1a / L2c / L3a / L4a)

| ID | Stage | Behavior |
|---|---|---|
| **L1a** | Lazy spawn | Relay spawned on first cross-machine inject for that host. No upfront daemon. |
| **L2c** | Idle timeout | Default unlimited (configurable). Relay does not auto-terminate on PTY traffic idleness — only on explicit shutdown. |
| **L3a** | Auto-restart (audit-level state recovery, **not** in-flight TCP/SSH session recovery) | launchd / systemd-user / Windows Service spawns a fresh relay process on crash. The new relay rereads existing supervisor manifests + relay manifest/log to resume routing decisions. **In-flight cross-machine SSH streams owned by the dead relay are not transparently resumed** — outstanding `inject` frames sent during the crash window are rejected per M40 binary reachability (§17.3); senders retry once the new relay is alive. Same 1-process trade-off as H1/M34 supervisor recovery. |
| **L4a** | Discovery | manifest cache → SSH config → Tailscale, in that order. |

Relay startup writes:

```
~/.telepty/relay/manifest.json
~/.telepty/relay/log.jsonl
```

### §8.3 Routing data path

```
[remote relay-A]                             [local relay-B]
       ↑   SSH stream (NDJSON over stdin/stdout)   ↑
       ↓                                            ↓
[remote supervisor X]                       [local supervisor Y]
       ↑                                            ↑
   PTY stdin/stdout                          PTY stdin/stdout
```

A cross-machine inject from machine A to session Y on machine B follows: `client → relay-A → SSH-mux → relay-B → UDS → supervisor Y → PTY`.

### §8.4 Why relay ≠ supervisor (responsibility split)

A naive design merges relay+supervisor (every supervisor accepts SSH directly). **Rejected** because:

- it requires every PTY to listen on SSH, expanding the security boundary;
- it forces SSH connection multiplexing logic into every supervisor (bloats E3 RAM);
- it forfeits the per-host SSH key/control-socket consolidation that the relay enables.

**Relay = SSH boundary; supervisor = PTY boundary.** The two responsibilities are intentionally split (Article 3 역할).

### §8.5 Why not SSH ControlMaster (M23 detail)

SSH ControlMaster reuses connections but does not understand telepty sessions. It cannot:

- validate `sid` routing;
- emit telepty audit logs;
- enforce V4 inbox policy / consent;
- expose relay health;
- maintain platform-neutral semantics for Windows;
- become the SSOT for reachability.

Therefore M23 mandates a persistent telepty-relay per host instead.

---

## §9 Per-Session Supervisor (1-process model)

### §9.1 Process model

- 1 OS process per session, owns 1 PTY, 1 UDS endpoint, 1 manifest, 1 log.
- Single-thread tokio runtime + jemalloc (M24, M31).
- Linkable as `cdylib` for embed (M28, per §14 Rust LOCK 2026-05-12).

### §9.2 RAM cost — honest accounting

- Idle Rust supervisor target: **5–8 MB RSS** (single-thread + jemalloc tune per M31); binding E3 ceiling ≤15 MB per ADR-E3-r1; future Phase 4 may tighten to ≤10 MB by follow-up ADR (evidence-gated).
- N = 100: **500–800 MB**. N = 1000: **5–8 GB**. Within reach of modern hosts; **infrastructure is the bound, not the design** (M29).
- Comparison: 0.3.x single-shared-daemon at N = 30 already exceeds 600 MB RSS and crashes the whole tree on a single PTY parser bug. The new model uses comparable RAM at N = 100 with full crash isolation.

### §9.3 N evolution path

- **Phase 1–2 (Q'''-bis launch)**: linear RAM scaling, no internal pooling.
- **Phase 4+ option A**: per-CPU-core hybrid (1 supervisor process per core, multiplexes K sessions internally).
- **Phase 4+ option B**: idle-suspended supervisor (swap to disk on idle, resume on next inject).

Both are evolution paths, **not Phase 1 commitments**.

### §9.4 Why single-thread tokio per supervisor

- PTY I/O is serialized at the kernel boundary (one ptmx fd, one read, one write). Multi-thread tokio adds per-worker stack RAM (typical 2 MB × 4 = 8 MB overhead per supervisor) without throughput gain.
- Single-thread also collapses race surface: no cross-thread coordination on inject ack, log offset, or manifest write.

### §9.5 Why 1-process per session (vs. K-sessions per process)

- **F1 crash isolation**: a PTY parser bug in session A cannot kill session B.
- **D1–D3 cdylib embed**: an embedding host that wants exactly one session does not pay for a multi-session daemon.
- **Operational simplicity**: launchd/systemd unit = one supervisor; failure attribution is direct.

---

## §10 Performance and Capacity

### §10.1 Target budgets

| Budget | Target |
|---|---|
| Local inject | < 1 ms supervisor hop (E1) |
| Cross-machine inject | ≤ 20 ms RTT expected; p99 < 100 ms (K1) |
| Cold start | < 500 ms (E2) |
| Supervisor RSS | ≤ 15 MB (E3 amended per ADR-E3-r1) |
| Idle CPU | < 0.1 % (E4) |
| Session count | unlimited up to infrastructure limits (M29) |

### §10.2 RAM model

Q'''-bis accepts linear RAM:

```
RAM ≈ supervisor_RSS × session_count + relay_RSS_per_host
```

Source brief estimate: Rust supervisor 5–8 MB × N. Acceptable because:

- one session crash no longer threatens all sessions;
- V1 parallelism should be infrastructure-bound, not arbitrary-cap-bound;
- Phase 4 explicitly reopens RAM/perf evolution;
- per-CPU-core hybrid and idle-suspended supervisors remain future paths.

### §10.3 E3 closure (precondition C1 closed)

E3 is amended from ≤ 10 MB to ≤ 15 MB per ADR-E3-r1 on cross-LLM empirical evidence (deliberation 2026-05-10, 3-LLM consensus): default Rust+tokio idle is 12–20 MB; the M24+M31 mechanism brings the best case to 5–8 MB but does not produce a reliable ≤ 10 MB ceiling across all three OS targets. The 15 MB ceiling absorbs ≈ 2× safety margin over best-case while preserving binding-class invariant character (Article 13 객관성). Phase 4 measurement gates remain authoritative; if Phase 4 measurement closes ≤ 10 MB on all three OSes, the ceiling MAY be tightened by a follow-up ADR.

### §10.4 Build cost mitigation (M27)

If Rust remains the implementation language: use `sccache`; cache the cargo workspace in CI; apply LTO selectively (release artifacts only, debug builds skip); keep protocol contract tests fast and platform adapter tests targeted; do not make full cross-OS perf tests a pre-merge gate for every doc-only change.

---

## §11 Security Model

### §11.1 Phase 1 security (OS ownership only)

| Surface | Control |
|---|---|
| session directory | owner-only permission (`0700`) |
| UDS path | owner-only directory + socket permission (`0600`) |
| Named Pipe | owner ACL |
| remote hop | OpenSSH key auth (existing user-managed keys) |
| remote address | Tailscale stable identity / address |
| audit | per-session `log.jsonl` |

telepty does **not** ship its own key management in Phase 1.

### §11.2 Explicit Phase 1 rejections

TCP loopback listener as local IPC; unauthenticated local HTTP server; direct remote supervisor injection bypassing relay for V4 external inject; token auth bolted onto Phase 1 without a contract test; public relay services for AI CLI traffic; mailbox / store-and-forward for unreachable receivers (M40).

**Reasoning**: UDS + SSH already provide a complete auth boundary for Phase 1 use cases. Introducing a new auth layer before measuring real-world cross-machine traffic patterns risks designing for the wrong threat model (Article 1 경량). B4 reserves the wire field; M11 Phase 2+ follow-up is the binding work item.

### §11.3 Phase 2+ security hooks (reserved)

HMAC token for inject auth (B4 / M11); per-contact ed25519 identity for V4 (sketch §V4-3); contact revocation; manual key rotation; inbox verification / promotion policy; additional audit redaction. V4 contact identity is a Phase 2 layer atop Phase 1 SSH-key auth and does not modify §11.1 / §11.2.

---

## §12 Phase Plan

### §12.1 Phase overview

| Phase | Work | Exit criteria | Indicative ETA |
|---|---|---|---|
| **0** | Preconditions C1–C4 | language and RAM risk reduced; go/no-go for Phase 1 | 2–5 days |
| **1** | Protocol + IPC + supervisor + manifest + log + 0.3.x bridge | local sessions work daemonless | 1–2 weeks |
| **2** | 3-OS adapter hardening + V4 cross-mesh + inbox + notification | macOS / Linux / Windows contracts pass; V4 ADR lands | 2–3 weeks |
| **3** | Persistent telepty-relay + optional AI-mediated triage | cross-machine relay default path works | 1–2 weeks |
| **4** | RAM/perf measurement gates and E3 promotion | E1–E4, K1 measured; E3 promoted or amended | 3–5 days |

ETAs are order-of-magnitude planning signals, not delivery commitments.

### §12.2 Phase 0 — Preconditions (must close before Phase 1 per §12.7.1 matrix)

Tasks:

1. ~~Run RAM spike for supervisor candidate (C1).~~ **Closed** by ADR-E3-r1 (2026-05-10, Option A: ≤15 MB) — see §13.1.
2. Run cdylib-in-tokio-host PoC (C2). **Phase 1 entry needs PoC result known** (PASS or FAIL); Phase 2 entry needs PASS.
3. Define sidecar/supervisor kill gates (C3). **Phase 2 entry only.**
4. Compare Node / Rust operational cost (C4 — Go disqualified per §15.2.5 ConPTY). **Phase 1 entry needs decision.**

Deliverables:

- precondition report;
- recommendation on supervisor binary language (Path B Rust vs Path A Node maintain);
- ~~E3 amendment recommendation~~ — already merged via ADR-E3-r1;
- explicit go/no-go for Phase 1 rewrite.

### §12.3 Phase 1 — Local core (no shared daemon required)

Tasks:

1. Define NDJSON schema + contract tests (M25, M37'/M38').
2. Implement POSIX UDS adapter.
3. Implement single-session supervisor (M24, M31).
4. Write manifest atomically (F3).
5. Append `log.jsonl` (G3).
6. Implement `list`, `inject`, `output`, `resize`, `signal`, `delete`.
7. Implement idempotent inject (F2, §6.5).
8. Provide launchd / systemd-user templates (or documented manual service wrapper).
9. Ship 0.3.x → 1.0 bridge (J3) for `inject / output / list` subset.

Exit:

- no shared daemon required for local session lifecycle;
- local inject p50 < 1 ms measured on reference host (or exception filed);
- manifest discovery stable under concurrent spawn/delete tests.

### §12.4 Phase 2 — Platform and V4 foundations

Tasks:

1. Harden macOS adapter.
2. Harden Linux adapter.
3. Harden Windows native Named Pipe adapter (no WSL substitution).
4. Land V4 cross-mesh ADR (separate doc).
5. Implement file-based inbox source of truth.
6. Implement one-line orchestrator notification (M39).
7. Implement binary reachability reject (M40).

Exit:

- POSIX and Windows tests pass;
- V4 notification format is **exactly**: `[INBOX from <alias>] <title ≤ 50 chars>`;
- no mailbox / store-and-forward semantics introduced.

### §12.5 Phase 3 — Persistent relay

Tasks:

1. Implement per-host relay.
2. Route SSH stream frames to local supervisor IPC.
3. Write relay manifest / log.
4. Add launchd / systemd restart with state recovery.
5. Add discovery fallback via manifest cache, SSH config, Tailscale names (M35).
6. Optionally prototype AI-mediated triage after relay baseline (V4 sketch §V4-5/§V4-11 expansion option).

Exit:

- cross-machine inject works through relay;
- K1 latency measured;
- relay restart recovers session routing without PTY loss.

### §12.6 Phase 4 — Measurement gates

Tasks:

1. Measure RSS for N sessions.
2. Measure idle CPU.
3. Measure cold start.
4. Measure local + remote inject latency.
5. Decide E3 promotion or amendment.
6. Decide whether per-CPU-core hybrid or idle-suspended supervisor work is needed (§9.3).

Exit:

- E1–E4 and K1 have data;
- E3 is either promoted to hard invariant or amended by explicit constitution amendment procedure.

### §12.7 ETA dependencies and gate matrix

#### §12.7.1 Phase entry gate matrix (r3 normalization — supersedes "C1–C4 gate Phase 1 entry" shorthand)

Each precondition gates a specific phase boundary; the earlier "all four gate Phase 1" wording was imprecise and is replaced by:

| Precondition | Phase 1 entry | Phase 2 entry | Phase 4 entry |
|---|---|---|---|
| **C1** (E3 RAM amendment) | ✅ closed by ADR-E3-r1 (2026-05-10, Option A: ≤15MB) — see §13.1 | — | — |
| **C2** (cdylib-in-tokio-host PoC) | required: **PoC result known (PASS or FAIL)** so Phase 1 can choose Path B (Rust supervisor) vs Path A (Node maintain). Result drives §14 supervisor-language row + M28 conditional voiding | required: **PASS verdict** — D1–D3 cdylib embed semantics depend on Rust C-ABI surface | — |
| **C3** (sidecar/supervisor kill gate spec) | — | required: closed `docs/spec-sidecar-kill-gate.md` so Phase 2 measurement gates have a concrete fail-fast contract | — |
| **C4** (bilingual ops cost analysis) | required: Path B (Rust) vs Path A (Node maintain) decision must be made; closed `docs/spec-bilingual-cost-analysis.md` (Path C / Go disqualified per §15.2.5 ConPTY) | — | — |

#### §12.7.2 Phase-to-phase dependencies

- Phase 0 → Phase 1: **C1 closed AND C4 closed AND C2 PoC result known** (per matrix above; C2 PASS/FAIL determines Phase 1 implementation language path).
- Phase 1 → Phase 2: **C2 PASS** (D1–D3 cdylib path) AND C3 closed.
- Phase 2 → Phase 3: V4 ADR acceptance (separate Phase 2 ADR doc).
- Phase 3 → Phase 4: production relay deployment maturity.

---

## §13 Open Questions and Preconditions (C1–C4)

These four preconditions are **gating** at different phase boundaries per the matrix in §12.7.1. In short: Phase 1 entry requires C1 closed + C4 closed + C2 PoC result known (PASS or FAIL); Phase 2 entry additionally requires C2 PASS + C3 closed. The earlier "all four close before Phase 1" wording (r1/r2) is superseded by §12.7.1 (r3).

### §13.1 C1 — E3 RAM amendment

**Question**:

```
Should E3 remain RAM ≤ 10 MB, or should the constitutionally accepted invariant become ≤ 15 MB?
```

**Required evidence**:

- supervisor RSS on macOS idle;
- supervisor RSS on Linux idle;
- supervisor RSS after inject/output churn;
- supervisor RSS with N = 1, 10, 50, 100;
- memory retained after session deletion.

**Acceptance**:

- if ≤ 10 MB is met, keep E3;
- if 10–15 MB is met and tradeoff is justified, run constitution amendment procedure;
- if > 15 MB, revisit architecture or implementation language.

**Owner**: architect + orchestrator. **Closure artifact**: Q'''-bis ADR amendment per ADR-E3-r1 (2026-05-10, Option A: ≤ 15 MB). `CONSTITUTION.md` is **untouched** per the amendment scope (ADR-E3 §16, §198, §239 explicitly: Constitution remains authoritative; the amendment lives in this ADR only). Affected sections (this ADR only): §4.E / §10.1 / §10.3 / §13.1 / §14 / §17.1.

**Acceptance scope** (per ADR-E3-r1 lines 97, 264 — inlined here for r3 traceability): macOS native + Linux native — both targets must measure ≤ 15 MB idle RSS with M24 + M31 tuning. **WSL is excluded** from the E3 acceptance set: WSL inherits Linux semantics + jemalloc tuning, which would dual-count the Linux measurement; WSL is treated as a Linux variant for parity but is not a separate E3 acceptance target. **Windows native E3 acceptance is pending** until C2 PoC closes (cdylib-in-tokio-host on Windows native must be feasible before E3 can be measured against Windows; if Path A — Node — wins C2, Windows E3 acceptance is re-derived for Node 0.3.x's actual RSS profile).

**Closure**: Closed by ADR-E3-r1 (2026-05-10), Option A: ≤ 15 MB. Phase 0 C1 task is therefore **closed** rather than "to-do" (see §12.2 strikethrough).

### §13.2 C2 — cdylib-in-tokio-host PoC (Phase 1 entry: result known; Phase 2 entry: PASS required)

**Question**:

```
Can the supervisor core run as a cdylib inside a Tokio host without runtime conflicts?
```

**Required evidence**:

- embed host starts and stops supervisor core;
- no nested runtime panic;
- clean teardown;
- two embedded sessions isolated (D3);
- no conflict with standalone supervisor (D2);
- at least 2 host languages exercised (e.g. Node + Swift, or Node + Go).

**Phase dependency** (r3 normalized — see §12.7.1):

- **Phase 1 entry** requires C2 **PoC result known** (PASS or FAIL). The result selects the Phase 1 implementation path: PASS → Path B (Rust supervisor + cdylib); FAIL → Path A (Node 0.3.x maintained, M28 voided per its row, D1–D3 reassessed for the chosen language).
- **Phase 2 entry** requires C2 **PASS** verdict — D1–D3 cdylib embed semantics depend on the Rust C-ABI surface; without PASS, Path A operates without the cdylib embed mandate.

### §13.3 C3 — Sidecar spike kill gate spec

**Question**:

```
What measured thresholds kill the sidecar / supervisor approach before full rewrite?
```

**Kill gate candidates**:

- RSS exceeds accepted E3 target by margin X;
- concurrency cannot reach target N under ulimit policy;
- PTY corner cases (resize, hangup, signal forwarding) not parity with 0.3.x;
- local inject latency misses by more than agreed margin;
- Windows native adapter cannot meet parity (no WSL substitution).

**Owner**: architect. **Closure artifact**: `docs/spec-sidecar-kill-gate.md`.

### §13.4 C4 — Bilingual ops cost analysis

**Question**:

```
Should implementation stay Node, move to Rust sidecar, or choose Go full rewrite?
```

| Option | Pros | Risks |
|---|---|---|
| Node maintained | lowest migration cost | RAM, daemon legacy, native IPC/perf complexity |
| Rust sidecar | best systems fit, cdylib path | bilingual build/release/debug cost |
| Go full rewrite | simpler static binary | PTY/Windows/native embed unknowns, less existing fit |

**Decision rule**:

- do **not** lock language in this ADR;
- use precondition evidence (C1, C2, C3 outcomes);
- preserve single-binary and embed requirements regardless of language.

**Owner**: architect + builder. **Closure artifact**: `docs/spec-bilingual-cost-analysis.md`.

---

## §14 Outstanding (TBD blanks)

| Area | Status | Owner | Resolution path |
|---|---|---|---|
| **Supervisor binary language** | **LOCKED 2026-05-12 → Rust.** *Locked 2026-05-12 per Phase 0 C2 (cdylib-in-tokio PoC, RSS 3.25 MiB, 5/5 PASS) + C4 Path B (bilingual ops cost report, Path C disqualified on Go #62708/#6271). See ADR-E3-r1 for E3=15MB and `docs/reports/2026-05-10-telepty-bilingual-ops-cost.md`.* Path A (Node maintain) retained as documented fallback only. | architect + orchestrator | **CLOSED (r6)** — closure artifacts: C2 report at `~/projects/aigentry-aterm/docs/experiments/2026-05-10-cdylib-tokio-nesting-poc/report.md`; C4 report at `docs/reports/2026-05-10-telepty-bilingual-ops-cost.md` |
| **Migration plan (0.3.x → 1.0)** | Separate plan ADR (#379), drafted after Phase 1 closure | builder + tester | Write `docs/adr/{date}-telepty-1-0-migration.md` once Phase 1 ships |
| **V4 cross-mesh full design** | Separate Phase 2 ADR. Sketch at `docs/specs/2026-05-10-v4-cross-mesh-sketch.md` | architect | Promote sketch → ADR after Phase 1 lands |
| **E3 (RAM 10 vs 15 MB)** | closed (ADR-E3-r1) | architect + orchestrator | Phase 0 C1 closed |
| **Per-CPU-core hybrid supervisor** | Phase 4+ option only | architect | Only revisit if Phase 4 measurement shows pathological N |
| **Phase 2 HMAC token (B4 / M11)** | Reserved wire field | architect | Phase 2 V4 ADR addresses (M11 follow-up) |
| **Exact manifest JSON Schema file path** | TBD | telepty implementer | Phase 1 |
| **Exact NDJSON contract fixture path** | TBD | telepty implementer | Phase 1 |
| **0.3.x migration shim lifetime** | TBD | migration ADR #379 | After Phase 1 |

Total: **7 explicit TBD blanks** (5 deferred from claude draft + 2 implementer-path TBDs from codex draft; supervisor-language row closed r6 per C2+C4 — retained as closed audit entry, not counted; E3 row retained as closed audit entry per ADR-E3-r1, not counted).

---

## §15 Alternatives Considered

The Q''' family generated multiple grill-stage candidates. Q'''-bis is one point in a designed space; the rejected alternatives are recorded so trade-offs are auditable. Where claude-draft's depth differed from codex-draft, both rationales are preserved. **Current count: 14 entries** (Q''', Path C, D, Q, I', Y, CC, N, O + 5 compact transport/cap variants in §15.9–§15.13). r2 added Path C (Go full migration disqualification per ConPTY analysis); §17.8 self-criticism + §22 self-check reflect the updated count.

### §15.1 Q''' (original) — single shared daemon, multi-process pool

- **Shape**: Rust daemon owns N PTYs in K worker processes (work-stealing pool).
- **Pros**: lower aggregate RAM than per-session (shared tokio runtime); familiar daemon-process model.
- **Rejected because**: (a) issue #15 (embed conflict) not solved — still one daemon competing with cdylib hosts; (b) crash blast radius reduced but not eliminated (a worker still owns ≥ 2 PTYs); (c) work-stealing across PTYs introduces non-trivial scheduler bug surface; (d) does not enable D2 daemon-less embed. **What survived into Q'''-bis**: per-session ownership direction; relay as cross-machine component; manifest/log as discovery/audit primitives.

### §15.2.5 Path C — Go full migration

- **Shape**: rewrite telepty in Go (10–15k LOC estimate per bilingual-ops analysis).
- **Pros**: Go's CI story is best (§5 dimension 2: 60–90 s vs Rust 2.5–5 min); single language; small dependency tree; broader contributor pool.
- **Rejected because**: Go's standard `os/exec` cannot set the `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` attribute required by Windows ConPTY. This is a language/stdlib-level limitation:
  - Go upstream issue #62708 — "os/exec: support setting CreateProcess startup info attributes"
  - Go upstream issue #6271 — "os/exec: support process startup attributes on Windows"
  - Workaround libraries (`aymanbagabas/go-pty`) require fork-and-patch of process spawning, losing the Go simplicity argument.
- Telepty's single most important value proposition is reliable PTY/ConPTY supervision on macOS/Linux/Windows. Path C forfeits that by attacking the primary requirement (C4 — Windows native).
- See `docs/reports/2026-05-10-telepty-bilingual-ops-cost.md` §5 / §7 / §10.1 for full disqualification analysis.

### §15.2 D — daemon-less, in-process per CLI

- **Shape**: each AI CLI links the supervisor as a library; no separate process.
- **Pros**: lowest RAM; no IPC.
- **Rejected because**: (a) loss of detach/reattach (A5) — when CLI exits, PTY dies; (b) loss of cross-CLI inject (orchestrator inject targeting claude session is impossible if claude owns the PTY in-process); (c) no cross-machine surface.

### §15.3 Q — multi-session per supervisor

- **Shape**: 1 supervisor per K sessions (group by tree or capacity).
- **Pros**: fewer processes; share tokio runtime overhead.
- **Rejected because**: (a) crash isolation degraded — K sessions share fate; (b) cdylib embed pays for K sessions when only 1 is wanted (D2 violation); (c) operational unit attribution becomes ambiguous; (d) per-session resource accounting opaque.

### §15.4 I' — in-host supervisor, daemon for cross-machine only

- **Shape**: supervisor runs in-process for local sessions; separate cross-machine daemon handles SSH multiplex.
- **Pros**: hybrid efficiency.
- **Rejected because**: (a) introduces two architecture variants (in-process vs. out-of-process) — doubles test surface and contract complexity; (b) Q'''-bis already gets the cross-machine benefit through relay (per-host, not global); (c) couples L2 to terminal-app availability if "in-host" = terminal — terminal must remain orthogonal (Article 3).

### §15.5 Y — shared daemon, per-session ephemeral child

- **Shape**: thin daemon owns the manifest dir; each session spawn forks a short-lived child that owns the PTY; daemon survives child crashes.
- **Pros**: crash containment + central manifest authority.
- **Rejected because**: (a) the "thin daemon" still owns global state (manifest write coordination), reintroducing issue #15 conflict for cdylib hosts; (b) two-process per session (daemon + child) doubles operational unit count without RAM savings vs. per-session supervisor.

### §15.6 CC — CRDT-based cross-machine state sync

- **Shape**: every machine maintains a CRDT replica of session state; cross-machine inject is a CRDT op.
- **Pros**: theoretical eventual consistency under partition.
- **Rejected because**: (a) CRDT for PTY data (an inherently linearizable byte stream) is a category error; (b) too complex for Phase 1; (c) M40 binary reachability (V4 lock) explicitly rejects store-and-forward — CRDT presumes it.

### §15.7 N — no daemon, no supervisor — direct PTY per CLI invocation

- **Shape**: every `telepty inject` re-opens the target PTY by `<id>` lookup; no persistent process.
- **Pros**: simplest model on paper.
- **Rejected because**: (a) PTY ownership requires a process holding the master fd; without a supervisor, PTY dies on every CLI exit (A5 violation); (b) cross-machine inject would need to spawn a remote process per call (K1 latency violation).

### §15.8 O — orchestrator-side daemon (or mailbox / store-and-forward)

- **Shape A**: orchestrator app owns all PTYs; CLI processes attach via orchestrator.
- **Shape B**: mailbox / store-and-forward queue for unreachable receivers (V4 variant).
- **Rejected because**: (Shape A) violates Article 3 — orchestrator is a control tower, not a runtime owner; couples L2 to a specific orchestrator implementation; breaks D1–D3; breaks cross-OS / cross-terminal orthogonality. (Shape B) M40 requires immediate reject when unreachable; offline queueing creates consent, expiry, replay, and privacy policy concerns before V4 needs them; file-based inbox is the source of truth only **after** receiver relay accepts the message.

### §15.9–§15.13 Compact rejections (transport / cap variants)

| Alternative | Shape | Rejected because |
|---|---|---|
| **TCP loopback for local IPC** | localhost TCP as local IPC | M22 rejects (§5.1); violates G2 no-network-listener default; loopback TCP inherits firewall/port/security ambiguity; UDS / Named Pipe give better owner-bound local semantics |
| **SSH ControlMaster as L2 transport** | reuse SSH connection multiplexing instead of telepty-relay | connection-reuse feature, not telepty-aware routing; no manifest/log semantics; cannot enforce V4 inbox consent; no Windows-native parity (M23 detail in §5.1, §8.5) |
| **Tailscale SSH mode** (instead of raw SSH over tailnet) | use Tailscale's SSH protocol mode for the authenticated stream | 2026-05-09 survey found daemon restarts kill existing Tailscale SSH sessions; port-22 semantics less flexible; raw SSH over tailnet preserves OpenSSH behavior and composes better with relay |
| **Public relay services (tmate-style)** | tmate-like public relay terminal | AI CLI sessions may contain code, prompts, credentials; relay trust posture wrong for default telepty; Tailscale + SSH gives private reachability without third-party plaintext exposure |
| **N=100 hard target** | bake N=100 cap into design (older brief) | user vision is V1 unbounded parallelism; real limit must be infrastructure-measured; arbitrary caps become product constraints before evidence. M29 supersedes |

### §15.10 Why Q'''-bis wins the trade-off

Q'''-bis is the **only** point that simultaneously satisfies (D1–D3, F1, K1, M29-unbounded, M40, M22, I3) without introducing a new architectural seam (extra daemon, CRDT layer, orchestrator coupling). Every alternative collapses on at least one binding requirement.

---

## §16 Consequences

### §16.1 Positive

| Positive | Why it matters |
|---|---|
| **Per-session crash isolation** | one PTY parser bug no longer kills all sessions (closes F-class defect of 0.3.x) |
| **Issue #15 closure** | embedded library coexists cleanly with other supervisors (D1–D3 binding) |
| **Cross-OS uniformity** | single contract test, per-OS adapter (M25); Windows native gains parity (no WSL dependency, C4) |
| **V1 ∞ scaling** | RAM scales linearly per session, no shared bottleneck; N is bounded by infra not telepty (M29) |
| **"Stateless dumb pipe" principle restored** | supervisor is single-purpose (one PTY); aligns with boundary ADR §3.1 (mechanism-vs-content split), reverses 0.3.x violation |
| **V4 forward-compat with zero new components** | M39 / M40 / V4 sketch reuses Q'''-bis surfaces (relay + manifest + NDJSON); no daemon, no broker (I3) |
| **NDJSON debuggability** | wire is human-readable in `tail -f log.jsonl`; contract test trivial; AI-CLI-friendly |
| **D1–D3 cdylib embed** | orchestrator app, brain, future hosts can embed the supervisor directly, removing daemon coordination from their concerns |
| **Better audit** | each session has its own structured log |

### §16.2 Negative

| Negative | Mitigation |
|---|---|
| **Rewrite cost** (~30% of 0.3.x replaced; 8–12 person-weeks Phase 1 estimate) | phase plan gates + migration ADR #379 |
| **Linear RAM scaling** (N = 100 → 500–800 MB RSS; visible vs. 0.3.x shared-daemon footprint) | jemalloc tuning (M31), measurement gates (Phase 4), hybrid path (§9.3) |
| **OS-specific adapter complexity** (UDS + Named Pipe diverge ~500–1000 LOC) | M25 contract test enforces wire equality |
| **Transitional bilingual ops cost** (Node 0.3.x + Rust 1.0 in parallel during migration) | C4 measures the cost; sunset by migration ADR #379 |
| **More process management** (every supervisor needs a launchd/systemd unit or generator) | unit templates shipped; first-spawn ulimit check (M30) |
| **Manifest fan-out on disk** (N supervisors → N manifest dirs + N log files) | not a bottleneck below N = 10 000; monitor inode usage on small filesystems |

### §16.3 Neutral

- **V4 cross-mesh details deferred** — separate Phase 2 ADR; no risk to Phase 1 if V4 changes shape.
- **Supervisor language LOCKED to Rust 2026-05-12** per §14 (Phase 0 C2+C4 closure). M28 Rust crate-type binding is now load-bearing — see §14 LOCK declaration. Path A (Node maintain) preserved as documented fallback only.
- **0.3.x sunset timing** — separate migration plan ADR; Phase 1 ships the bridge (J3); sunset is a later policy call.
- **Terminal app remains a user choice** — orthogonal by design.
- **Existing `telepty` commands may remain stable** while the implementation behind them changes.
- **tmux remains useful as a human fallback** but is not an L2 requirement.

---

## §17 Self-Criticism (Article 13 — 비판적 + 건설적 + 객관적)

per Constitution Article 13, this ADR records the strongest self-criticism the synthesis can muster against its own decisions. This section is **adversarial against the proposal** — the union of both source drafts' adversarial reviews, deduplicated and ordered by severity.

### §17.1 The RAM gamble is not free (E3 unproven)  *(source: claude draft §14.1 + codex draft §11.4(2), merged — see synthesis report lines 116-132)*

- **Criticism**: M29 declares N unbounded "to infra limit". On a typical laptop (16 GB), N = 1000 supervisors × 8 MB = 8 GB RSS — half the machine to telepty. "Modern hosts have 16–64 GB" hand-waves entry-level laptops. E3 itself is a precondition risk (C1 explicitly admits 10 MB may be unattainable), so the design currently rests on an unmeasured invariant.
- **Constructive answer**: M30 (first-spawn ulimit check) does not address RAM. We need a separate ops doc on "expected N for this host class" before V1 ∞ promises ship to users. C1 Phase 0 spike must include real RSS measurements on macOS arm64 + Linux x86_64 + Windows native, with N = 1, 10, 50, 100.
- **Closure note (r2)**: E3 ceiling closed by ADR-E3-r1 at 15 MB; M29 ∞ N criticism remains.

### §17.2 Single-thread tokio assumption is fragile  *(source: claude draft §14.2)*

- **Criticism**: M24 single-thread tokio is justified because PTY I/O is serial. But once a supervisor accumulates non-PTY duties (V4 inbox notification source, V2 parent-tree event publisher, future cost/quota tracking via I2), the single thread can become a bottleneck. We may regret M24 in Phase 3.
- **Constructive answer**: M25 contract test should include latency under simulated mixed-duty load; if degradation observed, M24 is re-evaluated rather than over-engineered upfront.

### §17.3 Per-host relay = SPOF for cross-machine  *(source: claude draft §14.3)*

- **Criticism**: M23 makes relay persistent and per-host. If the relay crashes and auto-restart (L3a) takes 5 s, every cross-machine inject in that window is rejected (M40 binary). This is "fast-fail" elegance but is also user-visible flakiness.
- **Constructive answer**: M40 explicitly rejects mailbox / store-and-forward, accepting this brittleness as a Phase 1 design choice. Phase 3+ revisit is allowed if production data shows it. K1 measurement (Phase 4) should include relay-crash injection tests.
- **Closure note (r3 — PTY recovery limit; H1/M34/L3a wording corrected)**: the same 1-process trade-off applies to **supervisor** crash recovery (not just relay). Killing the supervisor kills the PTY master FD; there is no second component holding the PTY. r3 corrects H1/M34/L3a wording so "state recovery" reads as **manifest + log artifact preservation only** — child CLI conversation state is owned by the child process itself, not telepty. Adding a second PTY-owning component to enable live recovery would violate the 1-process model (§9.5) and is intentionally out of scope; Phase 3+ may revisit if production data demands it.

### §17.4 NDJSON is human-readable but not future-proof for binary payloads  *(source: claude draft §14.4)*

- **Criticism**: M37' picks NDJSON for human readability and AI-CLI ergonomics. PTY output is inherently bytes (terminal escape sequences, ANSI, possibly malformed UTF-8 from buggy programs). Encoding raw bytes in JSON requires base64 or escape-heavy strings — a 4-byte CSI sequence becomes 12+ characters of JSON-escaped string. At high PTY throughput (`find /`, `tail -f` of busy log), JSON overhead is non-trivial.
- **Constructive answer**: M37' is locked for Phase 1, but a "kind-conditional binary frame" extension is technically compatible with M38' (add `kind:"output_b64"` for binary payloads, or `kind:"stream_open"` followed by raw bytes). Phase 4+ can promote a binary path if profiling shows JSON encoding is the bottleneck.
- **Closure note (r3 — trace_id required leakage)**: B3 r3 makes `trace_id` required for `inject`/`output` in Phase 1 (not Phase 2+ opt-in). This raises the cost of every future Phase 2+ wire change — Phase 2 HMAC token (B4 / M11), V4 contact identity, future kind additions — because the `trace_id` baseline is now a contract surface rather than an evolutionary field. Net cost ≈ 1.5× JSON-Schema scope per kind. Accepted as the lesser evil: the alternative (B3 enforced inconsistently against §6) is worse for cross-session causality and audit traceability.

### §17.5 Supervisor language TBD risk — MITIGATED 2026-05-12 (Rust LOCKED per C2+C4)  *(source: claude draft §14.5 + codex draft §11.4(3), merged; closure r6)*

- **Criticism** *(retained as historical record)*: §14 lists "supervisor binary language" as TBD with Rust leading. M28 (`crate-type = ["cdylib", "rlib"]`) presupposes Rust. If C2 fails and the language flips to Go, M28 is replaced by Go's `c-shared` build mode and the entire embed story is re-derived. The ADR is structurally Rust-leaning while claiming neutrality.
- **Constructive answer** *(retained as historical record)*: r2 should add a "language decision rubric" cross-referenced from M28, so when C2 closes, only one section needs amendment. Until then, treat M28 as conditional and update if C2/C4 reject Rust.
- **Closure note (r6, 2026-05-12) — risk MITIGATED (per C2+C4)**: Phase 0 evidence resolves both the TBD framing and the Rust-bias self-criticism in this entry's favor. C2 cdylib-in-tokio PoC PASSED_WITH_CONDITIONS (5/5 scenarios; RSS 3.25–3.42 MiB ≪ 15 MB E3; recommended pattern = extern "C" cdylib boundary + supervisor-owned tokio runtime + host `spawn_blocking`). C4 bilingual ops cost analysis selected Path B (Rust sidecar); Path C (Go full migration) DISQUALIFIED on Go `os/exec` ConPTY limitation (Go upstream issues #62708, #6271 — see §15.2.5). §14 supervisor-language row is now LOCKED → Rust. M28 Rust `crate-type` is now binding (no longer conditional on C2 outcome). Path A (Node 0.3.x maintain) is preserved as documented fallback at §14 and §16.2 for audit/contingency continuity, but is **no longer load-bearing** for any architecture decision in this ADR. The §5.1 r3 "Rust-conditional mandate notice" is retained with an r6 closure marker; M24/M27/M28/M31 are now simply Rust mandates rather than Rust-conditional mandates.

### §17.6 Phase 1 → Phase 2 dependency is steep  *(source: claude draft §14.6)*

- **Criticism**: Phase 1 ships supervisor + manifest + UDS + Named Pipe + bridge to 0.3.x. Phase 2 adds 3-OS adapter hardening + V4 + relay + inbox + notification — ~3× the Phase 1 surface, and the persistent relay (L1a/L2c/L3a/L4a) introduces a new lifecycle class Phase 1 has not exercised. The phase boundary may collapse under integration cost.
- **Constructive answer**: Phase 0 C2 (cdylib PoC) is a useful canary; the relay lifecycle should also have a Phase 0.5 spike to de-risk. Track relay PoC as an explicit C5 candidate if Phase 1 retros surface integration pain.

### §17.7 Boundary ADR drift on M30 (mitigated by wording)  *(source: claude draft §14.7 — drove M30 wording fix in synthesis body)*

- **Criticism / answer**: M30 originally read "install-time ulimit", which edged into devkit-content territory per the 2026-05-05 boundary ADR. This ADR re-words M30 as "**first-spawn ulimit check**" so the binding check belongs to telepty's first run; devkit `aigentry setup` may surface guidance only.

### §17.8 §15 alternatives table coverage is broader but still uneven  *(source: claude draft §14.8 — partly resolved by compact-table for short entries; r2 added Path C)*

- **Criticism**: claude r1 had 8 alternatives with uneven depth; codex r1 added 10 with tabular consistency. This synthesis has **14 entries (r2 added Path C — Go full migration disqualification per §15.2.5)**, incorporating both supersets, but per-entry depth still varies — Q''' / D / Q get richer paragraph-level rejection while CC / N / Tailscale-SSH / Public-Relay get one-paragraph dismissals. Reviewers may demand parallel structure (pros / cons / what-survived) for all.
- **Constructive answer**: r2 could normalize §15 entries to a 3-row table per alternative. For r1 we accept the asymmetry to keep the line budget.

### §17.9 Requirement count mismatch (31 label / 39 visible)  *(source: codex draft §11.4(1))*

- **Criticism**: The brief labels the constraint section "31 Binding Requirements" but A–K acceptance checks total 39. Earlier 0.3.x-era reviews accepted the 31 number without spotting the discrepancy.
- **Constructive answer**: this ADR exposes the mismatch in §1.5 and enumerates all 39 in §4. If the orchestrator normalizes the count, §4 is the canonical trace.

### §17.10 Windows risk is not a checkbox  *(source: codex draft §11.4(4))*

- **Criticism**: C4 (Windows native via Named Pipe) is one row in §4.C; reality is that Named Pipe semantics differ from UDS in non-obvious ways (creation race, ACL inheritance, message-mode vs byte-mode framing). WSL substitution is **not** parity (M25 must reject WSL substitution as a Windows test).
- **Constructive answer**: C4 acceptance must be Windows-native CI runs, not WSL CI runs. Test harness needs to fail-fast if it detects WSL-only execution attempting to claim Windows parity.

### §17.11 K1 latency claim requires measured evidence, not architecture alone  *(source: codex draft §11.4(5))*

- **Criticism**: K1 (≤ 20 ms RTT, p99 < 100 ms) is a budget derived from "Tailscale RTT 5–15 ms + relay framing < 2 ms + supervisor dispatch < 1 ms". Real measurements over actual Tailscale + SSH + relay paths can diverge — packet loss, congestion control, kernel scheduling jitter.
- **Constructive answer**: Phase 4 measurement gates explicitly require K1 measurement on real links (LAN + regional + transcontinental sample). If the budget breaks, M26 must be amended before V4 promises external UX.

### §17.12 Operational cost of many supervisors  *(source: codex draft §11.4(6))*

- **Criticism**: many supervisors are conceptually simpler but increase process count, ulimit pressure, service-observability requirements (each has its own launchd/systemd unit, log file, restart policy). Production ops may find this harder to monitor than 0.3.x's single daemon.
- **Constructive answer**: ship a `telepty status` aggregator that summarizes N supervisors + relay health in one CLI output; tooling investment must keep pace with the N-process model.

### §17.13 Constructive frame across all 12  *(source: codex draft §11.4 closing line — retained as numbered sub-point per synthesis report lines 116-132)*

The phase plan is the constructive answer to all 12 criticisms above. Phase 0 (preconditions C1–C4 per §12.7.1 matrix) and Phase 4 (measurement gates E1–E4, K1) exist precisely so the architecture is not declared correct on paper before the data arrives. Each criticism in §17.1–§17.12 is paired with a constructive answer that defers final acceptance to a measurable Phase 0/4 artifact rather than a paper claim. This is the binding meaning of Article 13 (비판적 + 건설적 + 객관적) for this ADR: criticism without a measurable answer is incomplete; an answer without an adversarial criticism is not yet objective.

### §17.14 r5 closure note (2026-05-10)

ADR cycle r1 → r2 → r3 → r4 → r5 complete. 4-cycle cross-LLM (claude ×3 + codex ×2 + Explore subagent) review framework validated. Average +10 lines per cycle (1495 → 1546 → ~1550). Recommend the same cadence (best-of-both synthesis → adversarial cross-LLM review → surgical-fix revisions until ACCEPT) for future tier-2 ADRs.

---

## §18 Constitution Check (Article 4 위헌 심사)

### §18.1 Q1 — Does this serve closing the AI tech gap?

**PASS**. Q'''-bis is the L2 surface that lets multi-CLI / multi-machine AI workflows scale beyond a single machine and a single CLI per machine. V1 ∞ + V4 cross-mesh are direct AI-tech-gap features (multi-agent collaboration across machines).

### §18.2 Q2 — Whose role is this feature?

**PASS**. telepty (L2 mechanism owner per boundary ADR §3.1) owns supervisor + manifest + IPC + relay + wire protocol. devkit owns install hooks (M30 first-spawn check is mechanism, not content; §17.7). orchestrator consumes M39 inbox notification but does not own L2.

### §18.3 Q3 — Is this framework / library actually needed?

**PASS**. Removing the daemon is a reduction, not an addition. Tailscale (L1) is reused. SSH (cross-machine transport) is reused. jemalloc is the only new dependency (statically linked) — needed for E3 RAM target. NDJSON / UDS / Named Pipe are OS-native; no library dependency.

### §18.4 Q4 — Does it work in all cross environments?

**PASS** (with verification). C3 + C4 require Linux + macOS + WSL + Windows-native parity. M25 contract test enforces. Failure mode: Phase 1 ships only OSes whose contract test is green; Windows-native may lag and ship in Phase 1.5.

### §18.5 Q5 — Does it avoid forcing "how" on users?

**PASS**. Terminal app (aterm/iTerm/kitty/etc.) is explicitly orthogonal (§2.4 / §3.1). User chooses the terminal; user chooses the AI CLI; telepty is a transparent L2.

### §18.6 Article-by-article alignment

| Article | Application | Status |
|---|---|---|
| 1 (경량) | Daemon-1 → Daemon-0 is removal; jemalloc is the only new dep | PASS |
| 2 (크로스) | C3 + C4 OS parity; terminal-orthogonal; CLI-agnostic | PASS |
| 3 (역할) | telepty=L2; orchestrator=control tower; aterm=terminal app — boundaries explicit | PASS |
| 5 (최선) | per-session supervisor is best on (D1–D3, F1, K1, M40); not a workaround | PASS |
| 7 (interoperability) | NDJSON, SSH, UDS / Named Pipe, versioned schemas | PASS |
| 9 (독립) | each supervisor independently operable; relay independent of supervisor | PASS |
| 13 (비판/건설/객관) | §17 self-criticism explicit (13 sub-points) | PASS |
| 15 (SSOT contracts) | protocol + manifest contracts must be registered during Phase 1 | PENDING (Phase 1 deliverable) |
| 17 (무의존) | OS-native IPC, no external broker, no plugin runtime; **explicit fallback inventory at §18.7** | PASS |

### §18.7 Article 17 dependency / fallback inventory (r3 addition)

Constitution Article 17 (lines 220-227 of `aigentry/docs/CONSTITUTION.md`) requires that every external dependency declare a fallback path so the system degrades cleanly rather than failing opaquely. Q'''-bis names three external dependencies (Tailscale, OpenSSH, jemalloc) at §18.3 / §10.3 / cross-machine paths; this section enumerates the fallback path for each.

| Dependency | Required for | Fallback if absent | Phase 1 dependency check |
|---|---|---|---|
| **Tailscale** (L1 fabric, §2.4) | Cross-machine reachability (V1/V4): relay discovery, K1 latency budget, cross-host inject path | **Local-only mode**: cross-machine inject/list explicitly returns `ERR_NOT_REACHABLE` (per §6.4); single-machine session lifecycle remains fully functional. User-facing message must name the missing dependency, not a generic network error. | first-spawn check (per M30 mechanism) detects `tailscaled` running; absence flips a manifest flag `cross_machine_capable: false` |
| **OpenSSH** (cross-machine NDJSON transport, §8.3) | Cross-machine inject + relay-to-relay framing tunnel | **Cross-machine unavailable**: same `ERR_NOT_REACHABLE`; single-machine fully functional; relay-A → relay-B path inert. | first-spawn check detects `ssh` binary + user key material; absence flips the same `cross_machine_capable: false` flag |
| **jemalloc** (E3 RAM budget, §10.3 / M31) | Bringing idle supervisor RSS below the ≤15 MB E3 ceiling on macOS + Linux | **System allocator fallback**: supervisor still runs, but **E3 cannot be certified** — Phase 1 perf gate FAIL is the explicit consequence. The supervisor should log a one-time WARNING at first-spawn (`telepty: jemalloc unavailable, E3 RSS budget cannot be certified`), and Phase 4 measurement gates record this as a gate-fail rather than silently passing. | build-time check (jemalloc statically linked into the supervisor binary); runtime check is a no-op if the artifact embeds jemalloc — fallback only triggers if a downstream packager strips it |

**Rule**: any future dependency added by Phase 2+/V4 work (e.g. Phase 2 HMAC token library, V4 contact identity ed25519 implementation) **must** add a row to this table, or the addition is unconstitutional under Article 17.

---

## §19 Implementation Handoff

### §19.1 Owned components

| Component | Owner repo | Notes |
|---|---|---|
| supervisor | `aigentry-telepty` | L2 session owner |
| relay | `aigentry-telepty` | cross-machine per-host process |
| CLI compatibility | `aigentry-telepty` | preserve user-facing command surface where possible |
| devkit scaffolding | `aigentry-devkit` | no change to boundary |
| aterm UI | `aigentry-aterm` | terminal app remains orthogonal |
| orchestrator dispatch | `aigentry-orchestrator` | consumes telepty commands and V4 notifications |

### §19.2 Initial contract tests (Phase 1 deliverable)

| Test | Purpose |
|---|---|
| `protocol/inject.v1` | validates inject frame schema |
| `protocol/output.v1` | validates output ordering |
| `protocol/resize.v1` | validates kind-conditional fields |
| `manifest/atomic-write` | reader never sees partial manifest |
| `ipc/uds-permission` | owner-only access on POSIX |
| `ipc/named-pipe-acl` | owner-only access on Windows native |
| `inject/idempotent` | duplicate op suppressed |
| `supervisor/crash-isolation` | one crash does not kill another session |
| `relay/reachability` | unreachable remote rejects immediately (M40) |
| `perf/local-inject` | local hop budget measurement (E1) |
| `perf/cross-machine-inject` | K1 measurement over Tailscale + SSH + relay |

### §19.3 Migration ADR dependency

```
Migration plan (0.3.x → 1.0): separate plan ADR #379, after Phase 1 completes
```

This ADR only requires that migration not be forgotten. It does not specify the compatibility shim lifetime.

---

## §20 Final Decision Record

### §20.1 Binding decisions (12)

1. Q'''-bis is the proposed L2 architecture.
2. Shared daemon is removed from session critical path (Daemon 1 → 0).
3. Per-session supervisor owns PTY (1 process : 1 session : 1 PTY).
4. Per-host telepty-relay exists only for cross-machine traffic.
5. Filesystem manifest is the discovery source of truth (atomic rename, `schema_version: 1`).
6. Structured per-session `log.jsonl` is the audit source.
7. Local IPC is UDS / Named Pipe, **not** TCP loopback.
8. Wire protocol is NDJSON with `v: 1`, kind-conditional fields.
9. Phase 1 auth is OS permission + SSH key auth only; **no telepty-level token** in Phase 1.
10. Single-binary multi-mode shape is required (`supervisor` / `relay` / `cli` / `embed`).
11. Supervisor binary language **LOCKED to Rust 2026-05-12** per Phase 0 C2 PASS_WITH_CONDITIONS + C4 Path B (see §14 LOCK declaration).
12. Migration plan is a separate ADR after Phase 1.

### §20.2 Explicit TBD blanks (7) — supervisor-language row closed r6

| TBD | Owner | When resolved |
|---|---|---|
| ~~supervisor binary language~~ → **LOCKED 2026-05-12 → Rust** (retained as closed audit entry) | orchestrator + telepty implementer | **r6 (2026-05-12)** — C2 PASS_WITH_CONDITIONS + C4 Path B selection |
| exact manifest JSON Schema file path | telepty implementer | Phase 1 |
| exact NDJSON contract fixture path | telepty implementer | Phase 1 |
| 0.3.x migration shim lifetime | migration ADR #379 | after Phase 1 |
| V4 cross-mesh full details | Phase 2 ADR | Phase 2 |
| per-CPU-core hybrid supervisor | architect | Phase 4+ (only if measurement demands) |
| Phase 2 HMAC token (B4 / M11) | architect | Phase 2 V4 ADR |
| relay-lifecycle Phase 0.5 spike (per §17.6) | architect | optional Phase 0 extension |

### §20.3 Non-binding recommendations

- Keep supervisor process code small enough to audit.
- Keep relay feature set narrow until V4 ADR lands.
- Write contract tests before broad implementation (TDD per Phase 1 §12.3).
- Measure before optimizing session count.
- Ship a `telepty status` aggregator early to keep observability ahead of the N-process model (§17.12 mitigation).

---

## §21 Appendix — Examples

### §21.1 Manifest example

> **Conditional example notice (r3; resolved r6 2026-05-12)**: as in §7.2, this manifest example uses the **Rust supervisor** path — **LOCKED per §14 (C2 PASS + C4 Path B)**. Historical contingency *(r3, retained for audit)*: under Path A (C2 FAIL → Node maintained), `"lang": "rust"` would have read `"lang": "node"`; all other fields are language-neutral.

```json
{
  "schema_version": 1,
  "id": "01HX...",
  "user": "duckyoungkim",
  "machine_id": "duckyoungkimui-MacBookPro.local",
  "tailscale_handle": "duckyoungkim@duckyoungkimui.tail-scale-net.ts.net",
  "parent_id": null,
  "cmd": ["claude"],
  "cwd": "/Users/duckyoungkim/projects/aigentry-orchestrator",
  "env": {"TELEPTY_SESSION_ID": "01HX..."},
  "created_at": "2026-05-10T01:30:00Z",
  "ipc": {
    "kind": "uds",
    "path": "/Users/duckyoungkim/.telepty/sessions/01HX.../supervisor.sock"
  },
  "supervisor": {
    "pid": 12345,
    "binary_version": "1.0.0",
    "lang": "rust"
  },
  "status": "ready",
  "protocol": { "wire_version": 1 },
  "cost_budget": null,
  "quota_class": null
}
```

### §21.2 Log example (`log.jsonl`)

```
{"ts":"2026-05-10T01:30:00.001Z","kind":"spawn_attempt","sid":"01HX","attempt":1,"argv_hash":"sha256:..."}
{"ts":"2026-05-10T01:30:00.025Z","kind":"spawn_ready","sid":"01HX","pid":12346,"pty":"/dev/ttys012","cwd":"/Users/duckyoungkim/projects/aigentry-orchestrator"}
{"ts":"2026-05-10T01:30:00.412Z","kind":"output","sid":"01HX","seq":1,"bytes":42,"trace_id":"01HX-O-bgnd-001"}
{"ts":"2026-05-10T01:30:01.103Z","kind":"inject","sid":"01HX","trace_id":"01HX-I-001","op_id":"...","bytes":8,"idempotency_key":"sha256:..."}
{"ts":"2026-05-10T01:30:01.108Z","kind":"output","sid":"01HX","seq":2,"bytes":8,"trace_id":"01HX-I-001"}
{"ts":"2026-05-10T01:30:30.001Z","kind":"signal","sid":"01HX","signal":"SIGINT"}
{"ts":"2026-05-10T01:30:30.050Z","kind":"output","sid":"01HX","seq":3,"bytes":4,"trace_id":"01HX-O-bgnd-002"}
{"ts":"2026-05-10T01:30:30.080Z","kind":"shutdown_drain","sid":"01HX","in_flight":0,"completed":3}
{"ts":"2026-05-10T01:30:30.099Z","kind":"delete","sid":"01HX","reason":"client-request"}
```

### §21.3 Wire example — cross-machine inject (relay perspective)

```
# relay-A (sender) frames sent over SSH stream to relay-B
{"v":1,"sid":"remote-codex@bob.tailnet","kind":"inject","data":"ls\n","trace_id":"01HX-X-007"}

# relay-B → supervisor X over local UDS
{"v":1,"sid":"01HX-X-suid","kind":"inject","data":"ls\n","trace_id":"01HX-X-007"}

# supervisor X → PTY → output streams back
{"v":1,"sid":"01HX-X-suid","kind":"output","seq":42,"data":"Cargo.toml\nsrc\n","trace_id":"01HX-X-007"}

# relay-B → relay-A (over SSH)
{"v":1,"sid":"remote-codex@bob.tailnet","kind":"output","seq":42,"data":"Cargo.toml\nsrc\n","trace_id":"01HX-X-007"}
```

### §21.4 Cross-machine reachability check (M40)

```
# pseudo (illustrative, non-executable)
fn reachable(target: TailscaleHandle) -> bool {
    tailscale_status_up()
        && ssh_reachable(target)
        && relay_running(target)
}
```

---

## §22 Self-check (Architect 7-item rubric)

1. **Context explains why** — YES (§1.3 D-1..D-4 + §2.1 / §2.3).
2. **Decision has ≥ 2 alternatives + trade-offs** — YES (§15: **14 alternatives** — Q''', Path C, D, Q, I', Y, CC, N, O + 5 compact transport/cap variants; r2 added Path C).
3. **Evidence-based rejection** — YES (cross-machine survey 2026-05-09; boundary ADR; vision.md; issue #14/#15; per-mandate "why rejected" in §5).
4. **Consequences includes failure modes** — YES (§16.2 + §17 13 self-criticism sub-points).
5. **Backward compat analyzed** — YES (§4.J + §6.7 + ADR #379 dependency).
6. **Constitution Check filled** — YES (§18: Q1–Q5 + Articles 1, 2, 3, 5, 7, 9, 13, 15, 17).
7. **Phase plan measurable** — YES (E1–E4 + K1 + M25 contract test gate; per-phase exit criteria).

Self-check: **7/7 PASS**.

---

## §23 History

- **r1 (2026-05-10)**: best-of-both synthesis from `*-claude.md` (829 lines) + `*-codex.md` (1261 lines) parallel drafts. Locked architecture: 3-Layer separation + Q'''-bis core + 31 binding requirements (39 visible acceptance checks) + 19 mandates M22–M40. Status `proposed`; preconditions C1–C4 must close before flip to `accepted`. Source drafts retained as history. Synthesis report at `docs/reports/2026-05-10-q-prime-bis-adr-synthesis-report.md`.
- **r2 (2026-05-10)**: E3 amendment integration (per ADR-E3-r1) + Path C disqualification (per bilingual-ops report) + §14 TBD language refinement. Verdict: post-r1 ACCEPT_WITH_FIXES. Edits: F1.1–F1.6 (E3 closure across §4.E / §10.1 / §10.3 / §13.1 / §14 / §17.1), F2 (§15.2.5 Path C — Go ConPTY disqualification), F3 (§14 supervisor-language row refinement), F4 (M28 callout). C1 precondition closed.
- **r3 (2026-05-10)**: 8 codex review fixes (E1 trace_id required for inject/output across §4 acceptance gate / §6.1 / §6.2 / 5+ frame examples; E2 H1 + M34 + L3a PTY recovery wording corrected to "crash detection + audit replay, not live PTY recovery"; E3 §12.7.1 gate matrix normalization separating Phase 1 / Phase 2 / Phase 4 entry; E4 §13.1 closure artifact reads "Q'''-bis ADR amendment, Constitution untouched" + OS/no-WSL acceptance detail inlined; E5 §17.13 numbered constructive frame + LLM source tags on §17.1–§17.12; E6 §15 alternative count normalized to 14 in §17.8 + §22; E7 §18.7 Article 17 dependency/fallback inventory for Tailscale + OpenSSH + jemalloc; E8 §7.2 + §21.1 manifest examples + §5.1 M24/M27/M28/M31 marked Rust-conditional). Verdict: post-r2 codex ACCEPT_WITH_FIXES → r3 surgical fixes only (architecture untouched). r3 self-criticism: trace_id-required leakage (B3 → §6 → all examples) increases future Phase 2+ wire-change cost — adding HMAC-token (B4/M11) or V4 contact-identity fields must accommodate `trace_id` as a Phase 1 baseline rather than a Phase 2 opt-in, ~1.5× JSON-Schema scope per kind.
- **r5 (2026-05-10)**: 3 minor textual fixes post-r4 codex review (ACCEPT_WITH_MINOR_FIXES) — Fix 1 trace_id leakage residue closed in §3.8 inject/output examples + §6.5 idempotency walkthrough (B3 + r3 E1 consistency); Fix 2 §9.2 line 802 stale E3 wording rewritten to "target 5–8 MB; binding E3 ceiling ≤15 MB per ADR-E3-r1; future Phase 4 may tighten to ≤10 MB by follow-up ADR (evidence-gated)"; Fix 3 §20.2 E3 TBD row removed (option a — explicit TBD count 9 → 8) + §14 total adjusted to 8 with E3 retained as closed audit entry. Status flipped `proposed → accepted` per C1 closure (E3) + r4 verdict. No architecture change.
- **r5+amend-A1A3 (2026-05-12)**: A1 wire `signal` enum extended (§6.2 + §6.2.1) to add `SIGKILL`, `JOB_TERMINATE`, `CTRL_BREAK_EVENT` and mark `SIGINT` POSIX-only. A2 error-code taxonomy extended (§6.4) with `ERR_UNKILLABLE_CHILD`, `ERR_PARENT_GONE`, `ERR_SUPERVISOR_GONE`, `ERR_MANIFEST_WRITE_FAIL`, `ERR_ESCAPED_DESCENDANT`, `ERR_PGRP_LIVE_AFTER_KILL`. A3 manifest `exit_reason` enum defined in §7.3 — `{normal, signaled, killed, crashed, unkillable}`; `orphan` explicitly NOT terminal. Drives **single-SSOT closure** of SPEC-C3-r1 §9.3 mandatory amendments per codex r2 Q6 recommendation. Status remains `accepted`; this is an additive contract amendment, not an architecture change. r5+amend-A1A3 self-criticism: the new `ERR_*` taxonomy adds 6 codes to the Phase 1 minimal set, increasing implementer/test-fixture surface — mitigated by marking `ERR_ESCAPED_DESCENDANT` and `ERR_PGRP_LIVE_AFTER_KILL` as optional/advisory in their cells (no enforced emission). No new §17 inventory row added (count remains at 14 per E5/E6 lock — the amendment is contract surface, not a new architectural risk).
- **r5+amend-A1A3+r6 (2026-05-12)**: supervisor language LOCKED to Rust per Phase 0 C2 (cdylib-in-tokio PoC PASS_WITH_CONDITIONS — 5/5 scenarios, RSS 3.25–3.42 MiB ≪ 15 MB E3; recommended pattern: extern "C" cdylib boundary + supervisor-owned tokio runtime + host `spawn_blocking`) + C4 Path B (bilingual ops cost analysis; Path C / Go DISQUALIFIED per §15.2.5 on Go `os/exec` ConPTY limitation, Go upstream issues #62708 + #6271). r6 textual flips: §1.6 Defers bullet (Defers → Locks audit entry); §3 line 393 (TBD pending C1–C4 → LOCKED per C2+C4); §5.1 r3 Rust-conditional mandate notice (closed marker + historical contingency frame); §7.2 r3 manifest conditional notice (closed marker); §9.1 cdylib bullet (`conditional on Rust language lock` → `per §14 Rust LOCK`); §14 supervisor-language row (TBD → LOCKED with exact dispatch-mandated declaration phrasing once); §14 TBD total 8 → 7; §16.2 Negative table (`Rust/TBD 1.0` → `Rust 1.0`); §16.3 Neutral bullet (TBD deferred → LOCKED per §14, conditional framing removed); §17.5 (title + closure note — risk MITIGATED, criticism + constructive answer retained as historical record); §20.1 binding decision 11 (TBD until C1–C4 → LOCKED per C2+C4); §20.2 TBD blanks table (count 8 → 7, supervisor-language row retained as closed audit entry); §20.3 first bullet removed (Rust now binding in §20.1.11); §21.1 r3 conditional example notice (closed marker). Status remains `accepted`; this is the evidence-based closure of §14 supervisor-language TBD row + §17.5 risk row, not an architecture change. Path A (Node 0.3.x maintain) preserved as documented fallback at §14 + §16.2 but is **no longer load-bearing**. A1–A3 enums, M22–M40 (including M28 row), 31/39 requirements, §17 14-entry inventory count, B3 trace_id required, E3=15MB ceiling, and manifest schema invariants all untouched. r6 self-criticism: with M28 binding now positive (not conditional), the §5.1 r3 "Rust-conditional mandate notice" has reduced load-bearing meaning — M24/M27/M28/M31 are now simply Rust mandates rather than Rust-conditional mandates. The notice is retained with an r6 closure marker rather than rewritten, preserving the historical contingency frame per audit-trail invariant.

---
