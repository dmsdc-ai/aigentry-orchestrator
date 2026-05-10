---
type: adr
status: proposed
revision: r1
date: 2026-05-10
author: aigentry-architect-claude-q-prime-bis
scope: ecosystem
decision_type: one-way
tier: T2
trigger: "Q'''-bis grill outcome (2026-05-10) — telepty 0.3.x daemon model has fundamental defects (issue #14 conflict, issue #15 embed conflict) that block V1 (∞ parallelism), V2 (recursive sessions), V3 (terminal-orthogonal UX) and V4 (cross-machine team comm). Daemon-1 → Daemon-0 + per-session supervisor + per-host telepty-relay rewrite is required before any Phase 2 feature work proceeds."
related:
  - "~/projects/aigentry-orchestrator/docs/adr/2026-05-05-telepty-devkit-boundary.md"
  - "~/projects/aigentry-orchestrator/docs/adr/2026-05-06-aterm-session-control-opt-3-prime.md"
  - "~/projects/aigentry-orchestrator/docs/specs/2026-05-10-v4-cross-mesh-sketch.md"
  - "~/projects/aigentry/docs/CONSTITUTION.md (Articles 1, 2, 3, 5, 9, 13, 17)"
  - "~/projects/aigentry-telepty/AGENTS.md"
  - "~/projects/aigentry-orchestrator/docs/rules.md (Rule 16, Rule 24, Rule 26, Rule 29)"
related_tasks: []
unblocks:
  - "telepty issue #14 (process conflict on second daemon spawn)"
  - "telepty issue #15 (embedded library cannot coexist with running daemon)"
  - "V1 ∞ parallelism vision (currently RAM-capped by single shared daemon)"
  - "V2 recursive session vision (parent-child PTY tree)"
  - "V4 cross-mesh team communication (sketch: docs/specs/2026-05-10-v4-cross-mesh-sketch.md)"
tags:
  - telepty
  - architecture
  - q-prime-bis
  - daemon-zero
  - per-session-supervisor
  - cross-machine
  - article-3
  - article-9
  - cleanup-then-feature
  - layer-separation
supersedes: []
reviewers_recommended: [codex, gemini]
revision_history:
  - r1: "2026-05-10 — initial draft from grill outcomes (locked architecture: 3-Layer separation + Q'''-bis core + 31 binding requirements + 19 mandates M22-M40). Cross-LLM verification: codex parallel draft for orchestrator best-of-both synthesis."
---

# ADR 2026-05-10: telepty L2 Session Architecture (Q'''-bis)

> **Cross-LLM dispatch note (2026-05-10)**: 본 문서는 orchestrator가 claude + codex 양쪽에 병렬 dispatch한 ADR 작성 태스크의 claude 산출물이다. 사용자가 두 결과를 비교해 best-of-both 합성 후 final commit. 본 문서는 자기 검토에서 정직성을 우선하고 (헌법 제13조), 다른 LLM이 다른 결정을 내릴 수 있음을 인지하며, 본인의 근거를 명시한다.

## §1 Status, Context, Trigger

### §1.1 Frontmatter summary

- **Status**: **proposed** (orchestrator가 codex 병렬 결과 합성 + 사용자 승인 + preconditions C1–C4 통과 후 `accepted` 전환).
- **Date**: 2026-05-10.
- **Tier**: **T2** — `type=adr × scope=ecosystem × decision_type=one-way` per `~/projects/aigentry-architect/references/frontmatter-schema.md`. 2 reviewer threshold (recommended: codex + gemini after orchestrator best-of-both synthesis).
- **Decision type**: **one-way**. L2 protocol surface (NDJSON wire, manifest schema, IPC transport, supervisor lifecycle) binds every downstream consumer (orchestrator, aterm, devkit, brain, dustcraw). Reverting requires cross-repo migration of code, history, and message schema. Per ADR-template §3 / Bezos one-way principle, this warrants up-front rigor.
- **Scope**: **ecosystem** — telepty (mechanism owner) + devkit (install/scaffold) + orchestrator (consumer + V4 inbox notification target) + aterm (consumer + UDS SendKey routing) + every CLI session that talks to telepty (claude/codex/gemini wrappers).

### §1.2 Trigger — why this ADR now

The 0.3.x telepty daemon (Node.js single-process, single-shared-bus, single-PID) accreted as a "make it work" prototype while V0 (basic inject/list/attach) was the only requirement. As V1 (∞ parallelism), V2 (recursive sessions), V3 (terminal-orthogonal UX), and V4 (cross-machine team comm) materialized in the 4-axis vision, four production-blocking defects surfaced:

| Defect | Manifestation | Issue |
|---|---|---|
| **D-1: Process conflict** | Second `telepty daemon` spawn refuses to start (port/PID lock) — embedded library cannot start its own daemon when one is already running for the user, breaking `cdylib` embedding | #14, #15 |
| **D-2: RAM ceiling** | Single shared daemon holds N PTYs in one process — RAM scales superlinearly with PTY count, capping practical N at ~30–50 sessions | V1 blocker |
| **D-3: Crash blast radius** | Any single PTY parser bug crashes the daemon → all N sessions die simultaneously | F-1 (reliability) |
| **D-4: Cross-machine ad-hoc** | No first-class cross-machine routing; current code shells out to `ssh ... telepty inject` per call (cold connection cost ~300–800ms per inject) | V4 blocker, K-class latency |

Direct verification (2026-05-09 cross-machine survey): the Tailscale + autossh combination handles L1 (machine reachability) cleanly; the gap is L2 (session addressability across the mesh). The 0.3.x daemon owns L2 today and is the bottleneck.

### §1.3 Inputs synthesized (binding)

| Input | Path | Frozen ref / Status |
|---|---|---|
| Q'''-bis grill outcomes (locked architecture) | dispatch source-of-truth | `~/.telepty/shared/0b575edfaa0a4ccd03fc4e5f270848e1b1675f14ca71ad1f306a12c5044bf0e5.md` (ingested 2026-05-10) |
| Boundary ADR (telepty/devkit role split) | `~/projects/aigentry-orchestrator/docs/adr/2026-05-05-telepty-devkit-boundary.md` | r4 accepted 2026-05-05 (commit `7c5575d`) |
| aterm opt-3-prime ADR (session control parity) | `~/projects/aigentry-orchestrator/docs/adr/2026-05-06-aterm-session-control-opt-3-prime.md` | r4 accepted 2026-05-06 |
| V4 cross-mesh sketch (Phase 2 follow-up) | `~/projects/aigentry-orchestrator/docs/specs/2026-05-10-v4-cross-mesh-sketch.md` | initial sketch 2026-05-10 |
| Cross-machine survey (Tailscale + autossh) | 2026-05-09 dustcraw report | survey conclusion: Tailscale recommended for L1; SSH ControlMaster ad-hoc rejected for L2 (cold cost) |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 3, 5, 9, 13, 17 | repo HEAD |
| 4-axis vision | `~/projects/aigentry/docs/vision.md` | repo HEAD (V1 ∞ / V2 recursive / V3 terminal-orthogonal / V4 cross-machine team) |

### §1.4 What this ADR locks vs. defers

**Locks (HARD):**

- 3-Layer separation (L1 machine / L2 session / L3 process) and the explicit non-coupling of the Terminal app dimension to any layer.
- Daemon-1 → Daemon-0 transition: per-session supervisor + per-host telepty-relay model.
- Wire protocol (NDJSON, M37'/M38', schema version 1).
- Local IPC = OS-native (UDS POSIX / Named Pipe Windows). TCP loopback explicitly **rejected** (M22, G2).
- 31 binding requirements (A–K) and 19 mandates (M22–M40, with M37'/M38' replacing earlier M37/M38).
- Phase plan (Phase 0 preconditions C1–C4 → Phase 1 protocol+supervisor → Phase 2 OS adapter + V4 → Phase 3 persistent relay → Phase 4 RAM/perf gates).

**Defers (TBD blanks — see §10):**

- **Supervisor binary language**. Rust is the leading candidate but the prior lock was revoked; selection is evidence-gated by Phase 0 preconditions C2 (cdylib-in-tokio-host PoC), C3 (sidecar spike kill gate), C4 (bilingual ops cost).
- Migration plan (0.3.x → 1.0) — separate plan ADR (#379), drafted after Phase 1 closure.
- V4 cross-mesh full design — separate Phase 2 ADR; this ADR only locks the M39/M40 surface needed for forward-compat.

---

## §2 Decision

### §2.1 3-Layer separation (HARD)

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

- **L1 — machine fabric**. Tailscale (or any equivalent WireGuard mesh) provides stable cross-OS machine addressability. telepty does **not** own L1; it consumes it.
- **L2 — session**. telepty is the L2 session layer. The Q'''-bis architecture is what this ADR specifies. Sessions are addressable PTY abstractions: each session has a stable `id`, a manifest, a UDS/Named-Pipe IPC endpoint, and an NDJSON wire schema.
- **L3 — process**. The actual program inside the PTY (claude/codex/gemini/shell). telepty is process-agnostic; the only assumption is "thing that reads/writes a PTY".
- **Terminal app — orthogonal**. The user's choice of physical terminal (aterm/iTerm/kitty/etc.) is **decoupled** from L1/L2/L3. No layer is allowed to require a specific terminal. (This locks the Article 2 / Article 3 / Article 9 invariants from the boundary ADR.)

### §2.2 Q'''-bis core (HARD)

- **Daemon: 1 → 0** — the legacy "single shared daemon owns all PTYs" model is **removed**. There is no long-running daemon process at the user level for L2. The supervisor is per-session; the relay is per-host.
- **Per-session supervisor**: 1 OS process per session. Owns exactly one PTY. Owns its IPC endpoint. Owns its manifest atomically.
- **Per-host telepty-relay**: 1 process per remote host (cross-machine routing only). Lazy-spawned on first cross-machine inject. Persistent. Re-entered via discovery.
- **Filesystem manifest**: `~/.telepty/sessions/<id>/manifest.json` — atomic-rename writes, `schema_version: 1`, plus a structured event log at `~/.telepty/sessions/<id>/log.jsonl`.
- **Local IPC**: UDS (POSIX) + Named Pipe (Windows). **TCP loopback is rejected** (rationale §4 M22, §3 G2 / M16 violation).
- **Single binary, multiple modes**: one compiled artifact runs as supervisor / relay / CLI / cdylib (D1–D3 embedded) depending on argv0 / arguments.

### §2.3 Why per-session supervisor

The brutal-honest core: a supervisor per session **trades RAM for almost everything else** — process isolation, crash containment, cdylib embedding, single-thread tokio runtime per session, jemalloc tuning per session, and (critically) zero shared mutable state across sessions. The trade is acceptable because (a) modern hosts have 16–64 GB RAM, (b) Rust supervisors target 5–8 MB each, and (c) RAM-limited pathological N is bounded by `ulimit -u` and disk, not by telepty design. See §3 (E3, E4) and §11 (Consequences — negative).

### §2.4 Why per-host telepty-relay

Cross-machine routing requires (a) connection multiplexing (avoid per-inject SSH cold-start ~300–800ms), (b) stable peer discovery (Tailscale handle + relay manifest), and (c) authentication boundary control (Phase 1 = SSH key, Phase 2 = HMAC token reserved). A persistent per-host relay amortizes the connection cost across all injects in a session lifetime; alternative SSH ControlMaster was rejected (M23) because its socket lifecycle / crash semantics do not match the supervisor lifecycle and add fragility.

---

## §3 Constraints — 31 binding requirements

The 31 requirements below are the binding contract. Each requirement has (a) a measurement criterion or test gate, and (b) a rejection-on-violation rule. Items A–J are derived from the grill; item K is **NEW** (cross-machine inject latency budget — locked in this ADR for the first time).

### §3.A Functional core (8)

| ID | Requirement | Measurement / Gate |
|---|---|---|
| A1 | **PTY ownership**: one supervisor process owns exactly one PTY (master+slave) | `lsof -p <pid>` → exactly 1 ptmx fd |
| A2 | **Inject**: write data to PTY stdin | `telepty inject <id> "x"` → next `output` frame contains `"x"` (echo) |
| A3 | **Output streaming**: PTY output → NDJSON `kind:"output"` frames | client subscription receives frames within 50ms of PTY write |
| A4 | **Signal**: SIGINT/SIGTERM/SIGHUP delivery to PTY child | `telepty signal <id> SIGINT` → child receives signal (verify via `wait()` exit code) |
| A5 | **Detach / Reattach**: client may disconnect; supervisor persists; reconnect resumes | client kill → supervisor stays alive; new connect resumes output stream from log offset |
| A6 | **Stable session ID**: assigned at spawn, persisted in manifest, immutable | manifest `id` field present; no rewrite on reattach |
| A7 | **List**: enumerate live sessions on this host | `telepty list --json` returns all sessions whose manifest exists and supervisor is alive |
| A8 | **Delete**: graceful supervisor termination + manifest cleanup | `telepty delete <id>` → SIGTERM supervisor → drain in-flight → unlink manifest |

### §3.B Identity / Tracing (4)

| ID | Requirement | Measurement |
|---|---|---|
| B1 | **User × machine identity**: every session manifest records `user`, `machine_id`, `tailscale_handle` (if mesh-joined) | manifest schema check |
| B2 | **Parent ID**: V2 recursive sessions record `parent_id` (null for top-level) | manifest schema check; V2 session creation populates `parent_id` from caller |
| B3 | **Trace ID**: every inject and output carries `trace_id` (UUID v7) for cross-session causality | NDJSON `trace_id` field present on inject/output kinds |
| B4 | **Inject auth (Phase 2 reserve)**: HMAC token surface reserved in wire schema (`auth_token` optional field), but not enforced in Phase 1 | Phase 1: field unused. Phase 2: M11 follow-up enforces. |

### §3.C Cross-machine + Platform (4)

| ID | Requirement | Measurement |
|---|---|---|
| C1 | **UDS + SSH-as-IPC**: cross-machine relay tunnels NDJSON over SSH stream (existing OpenSSH transport) | integration test: relay-A → SSH → relay-B → supervisor delivers inject |
| C2 | **Tailscale L1**: relay discovery via Tailscale handle + manifest mirror | relay startup resolves `<user>@<machine>.<tailnet>.ts.net` via tailscaled |
| C3 | **Linux / macOS / WSL parity**: identical NDJSON wire, identical UDS path layout, identical manifest schema | per-OS adapter test (M25 contract test) green on Linux+macOS+WSL |
| C4 | **Windows native**: Named Pipe transport (no WSL dependency); identical wire/manifest semantics | Windows native build runs supervisor + CLI without WSL; `\\.\pipe\telepty-<id>` named pipe present |

### §3.D Embedded (3)

| ID | Requirement | Measurement |
|---|---|---|
| D1 | **Library API**: supervisor mode is reachable via `cdylib` symbols, not only as standalone process | C API exposes `telepty_spawn / telepty_inject / telepty_close`; smoke test from a host process |
| D2 | **Daemon-less embed**: embedding host (orchestrator app, brain, etc.) does not require any external daemon to coexist | cdylib host runs in process X with PID P; no other telepty PID is required for spawn/inject |
| D3 | **Conflict isolation (issue #15 closure)**: multiple cdylib embeds in different host processes do not collide | run host-A and host-B simultaneously, both spawn 1 session each; no UDS / manifest collision |

### §3.E Performance (4)

| ID | Requirement | Measurement |
|---|---|---|
| E1 | **Local inject latency**: < 1 ms (median) for `telepty inject` on the same host | microbenchmark: 10k injects, p50 < 1ms, p99 < 5ms |
| E2 | **Cold start**: supervisor spawn → first inject acceptance < 500 ms | E2E test: `telepty spawn` returns; immediate inject succeeds within 500ms |
| E3 | **RAM**: ≤ 10 MB RSS per idle supervisor (Rust-built, jemalloc tuned) | post-spawn `ps -o rss` snapshot ≤ 10 MB. **C1 amendment** if Phase 1 measurement shows 10–15 MB unavoidable; constitution amendment process applies (see §10) |
| E4 | **Idle CPU**: < 0.1 % per supervisor when PTY is silent | `top -p <pid>` over 60s window |

### §3.F Reliability (3)

| ID | Requirement | Measurement |
|---|---|---|
| F1 | **Crash isolation**: supervisor crash kills only its own session, not others | kill -9 supervisor-A; supervisor-B/C continue serving |
| F2 | **Idempotent inject**: a duplicate inject (same `trace_id`) is detected and acknowledged exactly once | replay test: same NDJSON frame submitted twice → child sees data once |
| F3 | **Atomic discovery**: manifest writes use `rename()` to avoid partial-read races | concurrent reader observes either old-complete or new-complete manifest, never partial |

### §3.G Security (3)

| ID | Requirement | Measurement |
|---|---|---|
| G1 | **POSIX permission**: UDS socket file is `0600` (owner-only). Manifest dir `~/.telepty/sessions/` is `0700` | `stat` check after spawn |
| G2 | **No network listener by default**: supervisor binds only to UDS / Named Pipe; no TCP loopback, no 0.0.0.0 listener | `ss -tlnp` / `netstat -an` shows no telepty TCP listener post-spawn |
| G3 | **Audit trail**: every inject/signal/delete writes a `log.jsonl` entry with `(ts, kind, actor, trace_id)` | log inspection after operations |

### §3.H Operability (3)

| ID | Requirement | Measurement |
|---|---|---|
| H1 | **Self-supervision**: supervisor crash → launchd (macOS) / systemd-user (Linux) / Windows Service auto-restart with state recovery | crash test: kill -9 supervisor → restart within 5s with same `id`, manifest replays log offset |
| H2 | **Disk policy**: per-session log rotation default 100 MB; old segments compressed; configurable cap | log file size bounded; rotation observed on threshold |
| H3 | **Single binary**: one shipped artifact `telepty` switches modes via subcommand or argv0 (`telepty-supervisor`, `telepty-relay`, etc.) | `file telepty` is one binary; mode switch test |

### §3.I Composability for V1+V2+V4 (3)

| ID | Requirement | Measurement |
|---|---|---|
| I1 | **Tree-aware**: V2 recursive parent→child relationships expressed via `parent_id` and queryable through `telepty list --tree` | tree query returns hierarchy |
| I2 | **Cost / quota hooks**: per-session metadata fields (`cost_budget`, `quota_class`) reserved in manifest for downstream gating | manifest schema includes optional fields |
| I3 | **V4 forward-compat**: M39 (inbox notification format), M40 (binary reachability) and the V4 sketch consume Q'''-bis surfaces with **zero new components** | V4 ADR (Phase 2) does not introduce new daemon/relay processes |

### §3.J Compatibility (3)

| ID | Requirement | Measurement |
|---|---|---|
| J1 | **Wire protocol versioned**: `v: <int>` field on every NDJSON frame; mismatched versions reject with `kind:"error"` | mismatch test |
| J2 | **Manifest schema versioned**: `schema_version` field; consumers gracefully reject unknown versions | gracefully degrade |
| J3 | **0.3.x backward-compat**: 0.3.x clients can talk to 1.0 supervisor for the deprecated subset (inject/list/output) during the migration window (separate ADR #379 details) | bridge layer in 1.0 supervisor honors 0.3.x wire for `kind ∈ {inject, output, list}` |

### §3.K (NEW) Cross-machine inject latency (1)

| ID | Requirement | Measurement |
|---|---|---|
| K1 | **Cross-machine inject RTT**: median ≤ 20 ms, p99 < 100 ms, on Tailscale LAN/regional links | E2E test: relay-A → relay-B → supervisor → ack frame; latency-budget breakdown ≤ 20 ms = (Tailscale RTT 5–15ms) + (relay framing < 2ms) + (supervisor dispatch < 1ms) |

K1 is **new in this ADR** (not in pre-grill drafts). Justification: V4 inbox notifications and orchestrator-mediated team comm (notification within 1 turn boundary) require a hard latency cap to be a usable interaction primitive. Without K1, the V4 UX degrades from "team chat-like" to "delayed batch", which is the surveyed-rejected design (cross-machine survey 2026-05-09).

---

## §4 Mandates — M22 to M40

Mandates are **derived rules** that constrain implementation while leaving room for tactical choice. Each mandate cites the requirement(s) it serves and the alternative it rejects. Mandates M37 and M38 from earlier drafts are superseded by M37' and M38' (NDJSON wire, kind-conditional fields).

### §4.M22 OS-native local IPC (UDS POSIX / Named Pipe Windows)

- **Rule**: local supervisor↔CLI / supervisor↔relay traffic uses UDS on POSIX and Named Pipe on Windows. **TCP loopback is rejected.**
- **Serves**: G2 (no network listener), C3/C4 (cross-OS parity), E1 (latency).
- **Why TCP loopback is rejected**: (a) violates G2 ("no network listener default") because TCP loopback still creates a port-bind syscall observable to local network scanners and to security policy auditors; (b) violates the M16 invariant from Article 9 ("each component independently operable") because TCP requires port allocation policy that conflicts with multiple supervisor instances; (c) loses POSIX file permission semantics — UDS naturally enforces `0600` while TCP loopback opens to all local users.

### §4.M23 Persistent telepty-relay per host (NOT SSH ControlMaster)

- **Rule**: cross-machine routing uses a long-lived telepty-relay process per remote host. SSH ControlMaster reuse is **rejected** as the L2 transport.
- **Serves**: K1 (cross-machine latency), F1 (relay crash isolated from supervisor), I3 (V4 forward-compat).
- **Why ControlMaster rejected**: (a) ControlMaster socket lifecycle is owned by openssh, not telepty — supervisor crash recovery cannot atomically restart the multiplexed connection; (b) ControlMaster does not multiplex *application-level* framing — every inject still pays one ssh-channel-allocation roundtrip; (c) error semantics on ControlMaster socket EOF are ambiguous and have caused intermittent inject losses in 0.3.x.

### §4.M24 Single-process supervisor (single-thread tokio + jemalloc)

- **Rule**: each supervisor is a single OS process with one tokio runtime configured to a single worker thread. Allocator is jemalloc (linked statically) with the tuning in M31.
- **Serves**: E3 (RAM), E4 (idle CPU), F1 (crash isolation), F2 (idempotency simplification — no cross-thread race).
- **Why single-thread**: PTY I/O is intrinsically serial (one read end, one write end); multi-thread tokio doubles RAM (per-worker stack) without throughput gain. The session is the parallelism unit, not the thread.

### §4.M25 Protocol contract test (binding) + per-OS adapter (free)

- **Rule**: NDJSON wire + manifest schema + IPC framing form a **binding contract** validated by a single contract test suite shared across OSes. Per-OS adapter implementations (UDS vs Named Pipe binding) are free — they only need to satisfy the contract.
- **Serves**: J1, J2, C3, C4.
- **Why**: 0.3.x lacked a contract test, so each platform fork drifted; 1.0 enforces wire equality before allowing platform feature work.

### §4.M26 Cross-machine inject latency budget

- **Rule**: 10–20 ms RTT (Tailscale fabric typical) + framing/dispatch overhead, with K1 as the binding cap.
- **Serves**: K1.

### §4.M27 sccache + cargo workspace caching + LTO selective (CI mitigation)

- **Rule**: build pipeline uses sccache + cargo workspace + LTO only on release artifacts (debug builds skip LTO for fast iteration).
- **Serves**: developer ergonomics; not a runtime invariant.
- **Why explicit**: Rust full-tree LTO doubled CI time in early prototypes; this mandate fences the cost.

### §4.M28 Rust supervisor `crate-type = ["cdylib", "rlib"]` (D1–D3)

- **Rule**: the supervisor crate is built as both `cdylib` (for embed) and `rlib` (for the standalone binary). One source tree, two artifacts.
- **Serves**: D1, D2, D3.
- **Note**: this mandate **assumes** the supervisor language decision lands on Rust. If C2 (cdylib-in-tokio-host PoC) fails, M28 must be re-stated for the chosen language. See §10 supervisor-language TBD.

### §4.M29 N target = unlimited (was N=100)

- **Rule**: the design imposes **no hard ceiling** on session count N. The practical ceiling is the host's `ulimit -u` (process count), file descriptor limit, RAM, and disk. Earlier drafts capped N=100; this mandate revokes that cap.
- **Serves**: V1 ∞ parallelism vision.
- **Side**: M30 (install-time ulimit) covers the operational bound.

### §4.M30 Install-time ulimit auto-set or clear guidance

- **Rule**: telepty install (devkit `aigentry setup`) checks `ulimit -u` and `ulimit -n`, raising via launchd plist / systemd-user override / Windows GPO when within user permission, or printing **explicit** guidance otherwise.
- **Serves**: M29 operability tail.

### §4.M31 Per-supervisor jemalloc tuning

- **Rule**: each supervisor sets `MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0` to aggressively return idle memory to the OS.
- **Serves**: E3 (RAM), E4 (idle CPU).
- **Why**: jemalloc's default decay (10s+) holds RAM high after burst PTY output; aggressive decay returns RSS to the floor within milliseconds, which is what makes E3 (≤ 10 MB) attainable.

### §4.M32 Idle timeout default = unlimited (user configurable)

- **Rule**: a supervisor with an attached PTY child does **not** auto-terminate on idle by default. Users may configure `idle_timeout_seconds` per session or globally.
- **Serves**: V1 (long-lived AI sessions), F1 (no surprise teardown).

### §4.M33 Spawn graceful — 3 retries × exponential backoff

- **Rule**: supervisor spawn that fails (UDS bind contention, log dir creation race, etc.) retries 3 times with exponential backoff (100ms, 400ms, 1.6s) before surfacing an error.
- **Serves**: F-class reliability under transient install/upgrade contention.

### §4.M34 Crash graceful — auto-restart + state recovery

- **Rule**: launchd KeepAlive (macOS) / systemd-user `Restart=on-failure` (Linux) / Windows Service auto-restart restarts a crashed supervisor. On restart, the supervisor reattaches to the existing PTY (if PID-recoverable) or marks the session `terminated` and writes the final log line.
- **Serves**: H1, F1.

### §4.M35 Discovery graceful — manifest cache + SSH config / Tailscale fallback

- **Rule**: `telepty list` consults the manifest dir first (fast path), then the local Tailscale `tailscale status` cache, then SSH config aliases as a last-resort fallback.
- **Serves**: A7, C2, K1.

### §4.M36 All termination graceful drain (SIGTERM)

- **Rule**: SIGTERM to a supervisor triggers a graceful drain — flush log buffer, finish in-flight inject ack, write final manifest entry, then exit. SIGKILL bypasses (intentional). Default termination path uses SIGTERM.
- **Serves**: F2 (idempotency), G3 (audit trail).

### §4.M37' Wire frame = NDJSON (line-delimited JSON, UTF-8)

- **Rule**: every wire frame is a single line of UTF-8 JSON, terminated by `\n`. The base schema is `{v, sid, kind, data, ...}` where additional fields are **kind-conditional** (M38').
- **Why NDJSON over an alternative** (binary framing, MessagePack, Protobuf, gRPC): (a) NDJSON is human-readable in a tail of `log.jsonl` — debugging is `tail -f | jq`; (b) JSON is the lingua franca of AI CLI output (claude/codex/gemini already produce JSON tool outputs), zero schema friction; (c) framing complexity is one `splitlines()` call vs. a length-prefix decoder; (d) the throughput penalty (~2x bytes vs. msgpack) is irrelevant for PTY traffic (typical PTY << 1 MB/s, NDJSON ~200 KB/s overhead is fine on every modern transport including Tailscale).
- **Why not extensible**: kind-conditional fields (M38') mean adding `kind:"resize" {cols, rows}` does not require changing the base schema or breaking older parsers — they can ignore unknown kinds with `kind:"error" reason:"unknown_kind"`.

### §4.M38' Frame schema versioned (`v: 1`), kind-conditional fields

- **Rule**: every frame starts with `{"v":1, ...}`. The `kind` enum is `inject | output | spawn | delete | resize | signal | ping | pong | error`. Each kind has its own optional/required fields (e.g., `resize` requires `cols, rows`; `signal` requires `name ∈ {SIGINT, SIGTERM, SIGHUP}`).
- **Serves**: J1, J2 (versioned + graceful degrade).

### §4.M39 V4 inbox notification — single channel, file-based source of truth

- **Rule**: V4 cross-machine messages are surfaced via **exactly one** channel: the orchestrator session receives a 1-line inject with format `[INBOX from <alias>] <≤50-char title>`. This inject is **turn-end debounced** and **batched** (multiple messages in a single turn collapse). The full content lives in `~/.telepty/inbox/<msg-id>.json` (file-based source of truth). Configurable disable.
- **Serves**: I3, V4 sketch §V4-6.
- **Anti-rule**: no per-session pop-ups, no shell hooks, no terminal beeps — the orchestrator is the single notification destination so users have one place to look.

### §4.M40 V4 reachability — binary

- **Rule**: cross-machine sender computes reachability as `(Tailscale up) AND (SSH reachable) AND (relay running)`. If false, the sender **immediately rejects** the inject with a clear error. There is **no mailbox / store-and-forward**.
- **Serves**: I3, V4 sketch §V4-12 lock.
- **Why no store-and-forward in Phase 2**: queue semantics expand the security perimeter (mailbox = persistent storage of inter-user content) and the UX surface (delivery uncertainty) substantially. Phase 3+ may revisit if the binary policy proves too brittle.

---

## §5 Wire Protocol — NDJSON (M37'/M38' detail)

### §5.1 Base schema

```json
{"v":1,"sid":"<session-id>","kind":"<kind>","data":"<kind-conditional>","trace_id":"<uuid-v7>","ts":"<rfc3339>"}
```

- `v` (int, required) — protocol version. v=1 in Phase 1.
- `sid` (string, required) — session ID matching `manifest.id`.
- `kind` (enum, required) — one of `inject | output | spawn | delete | resize | signal | ping | pong | error`.
- `trace_id` (string, optional in v=1, required in v≥2) — UUID v7. Server fills if absent.
- `ts` (string, optional) — sender timestamp (RFC 3339).

### §5.2 Kind-conditional fields

| kind | required fields | optional fields |
|---|---|---|
| `inject` | `data` (string, UTF-8) | `auth_token` (B4 reserve), `idempotency_key` (default = `trace_id`) |
| `output` | `data` (string) | `seq` (monotonic integer, log offset) |
| `spawn` | `cmd` (array of string), `cwd` (string) | `env` (object), `parent_id` (B2), `cost_budget` (I2) |
| `delete` | — | `force` (bool, default false) |
| `resize` | `cols` (int), `rows` (int) | — |
| `signal` | `name` (enum: SIGINT/SIGTERM/SIGHUP) | — |
| `ping` | — | — |
| `pong` | — | `rtt_ms` (int) |
| `error` | `reason` (string), `code` (enum) | `frame_ref` (string) |

### §5.3 Worked examples

```
{"v":1,"sid":"remote-codex","kind":"inject","data":"task X\n","trace_id":"019..."}
{"v":1,"sid":"remote-gemini","kind":"output","data":"hello world\n","seq":4271}
{"v":1,"sid":"remote-claude","kind":"resize","cols":120,"rows":40}
{"v":1,"sid":"remote-claude","kind":"signal","name":"SIGINT"}
{"v":1,"sid":"remote-claude","kind":"error","reason":"unknown_kind","code":"E_UNKNOWN_KIND","frame_ref":"<offending-line>"}
```

### §5.4 Error codes (Phase 1 minimal set)

- `E_UNKNOWN_KIND` — kind not in enum (graceful degrade, sender retries with v↓ if applicable).
- `E_VERSION_MISMATCH` — `v` not supported by receiver.
- `E_AUTH` — Phase 2 reserve (M11).
- `E_NOT_REACHABLE` — M40 binary reachability fail.
- `E_INVALID_FRAME` — JSON parse fail or schema violation.
- `E_BACKPRESSURE` — supervisor input buffer full.

### §5.5 Backpressure policy

- Output frames: bounded ring buffer (default 64 MB per session); on overflow, oldest frames are dropped and a single `kind:"error" code:"E_DROPPED" count:<N>` frame is emitted.
- Inject frames: synchronous ack; on slow PTY, ack is delayed (no buffer growth on supervisor side).

---

## §6 Auth — Phase 1 (file permission + SSH key)

### §6.1 Local IPC

- **POSIX**: UDS socket file at `~/.telepty/sessions/<id>/sock` with mode `0600` (owner-only). Verified by supervisor on bind, rejected on permission drift.
- **Windows**: Named Pipe `\\.\pipe\telepty-<id>` with owner-only ACL (`SECURITY_DESCRIPTOR` set on `CreateNamedPipe`).

### §6.2 Cross-machine

- **SSH key**: existing OpenSSH key auth (`~/.ssh/id_ed25519` or user-configured). telepty does **not** ship its own key management in Phase 1.

### §6.3 Phase 1 explicitly rejects telepty-level token auth

- No HMAC token, no TLS, no application-level key exchange in Phase 1. The reasoning is (a) UDS + SSH already provide a complete auth boundary for Phase 1 use cases, and (b) introducing a new auth layer before measuring real-world cross-machine traffic patterns risks designing for the wrong threat model (Article 1 경량).
- B4 reserves the wire field; M11 (Phase 2 follow-up) is the binding work item.

### §6.4 V4 contact identity (forward reference)

- V4 sketch defines per-contact ed25519 keypairs at `~/.telepty/contacts/`. This is a **Phase 2** layer atop the Phase 1 SSH-key auth and does not modify §6.1/§6.2. See V4 sketch §V4-3.

---

## §7 Relay topology + lifecycle

### §7.1 Topology — T1 per-host single relay

- **T1 (Phase 1 default)**: per remote host, exactly one relay process per local user. Handles all sessions on that remote host for that user.
- **T2 (escalation option)**: per-user-per-host (only if multi-user host is in scope; not Phase 1). Phase 1 assumes single-user macOS / Linux user accounts.

### §7.2 Lifecycle (L1a / L2c / L3a / L4a)

| ID | Stage | Behavior |
|---|---|---|
| L1a | **Lazy spawn** | Relay is spawned on first cross-machine inject for that host. No upfront daemon process. |
| L2c | **Idle timeout** | Default unlimited (configurable). The relay does not auto-terminate on PTY traffic idleness — only on explicit shutdown. |
| L3a | **Auto-restart with state recovery** | launchd / systemd-user / Windows Service restarts the relay on crash; state recovery reads existing manifests on restart. |
| L4a | **Discovery** | manifest cache → SSH config → Tailscale `tailscale status` cache, in that order. |

### §7.3 Relay → supervisor routing

```
[remote relay-A]                             [local relay-B]
       ↑   SSH stream (NDJSON over stdin/stdout)   ↑
       ↓                                            ↓
[remote supervisor X]                       [local supervisor Y]
       ↑                                            ↑
   PTY stdin/stdout                          PTY stdin/stdout
```

A cross-machine inject from machine A to session Y on machine B follows: `client → relay-A → SSH-mux → relay-B → UDS → supervisor Y → PTY`.

### §7.4 Why relay is not the supervisor

A naive design merges relay+supervisor (every supervisor accepts SSH directly). This is **rejected** because (a) it requires every PTY to listen on SSH, expanding the security boundary; (b) it forces SSH connection multiplexing logic into every supervisor (bloats E3 RAM); (c) it forfeits the per-host SSH key/control-socket consolidation that the relay enables. Relay = SSH boundary; supervisor = PTY boundary; the two responsibilities are intentionally split (Article 3 역할).

---

## §8 Per-Session Supervisor (1-process model)

### §8.1 Process model

- 1 OS process per session, owns 1 PTY, 1 UDS endpoint, 1 manifest, 1 log.
- Single-thread tokio runtime + jemalloc (M24, M31).
- Linkable as `cdylib` for embed (M28).

### §8.2 RAM cost — honest accounting

- Idle Rust supervisor: target 5–8 MB RSS (jemalloc tuned per M31). E3 caps at 10 MB; C1 amendment process to 15 MB available if measurement demands it.
- N=100: 500–800 MB. N=1000: 5–8 GB. Within reach of modern hosts; **infrastructure is the bound, not the design** (M29).
- Comparison: the 0.3.x single-shared-daemon at N=30 already exceeds 600 MB RSS and crashes the whole tree on a single PTY parser bug — the new model uses comparable RAM at N=100 with full crash isolation.

### §8.3 N evolution path

- **Phase 1–2 (Q'''-bis launch)**: linear RAM scaling, no internal pooling.
- **Phase 4+ option**: per-CPU-core hybrid (1 supervisor process per core, multiplexes K sessions internally) **OR** idle-suspended supervisor (swap to disk on idle, resume on next inject). Both are evolution paths, not Phase 1 commitments.

### §8.4 Why single-thread tokio per supervisor

- PTY I/O is serialized at the kernel boundary (one ptmx fd, one read, one write). Multi-thread tokio adds per-worker stack RAM (typical 2 MB/worker × 4 workers = 8 MB overhead per supervisor) without throughput gain.
- Single-thread also collapses race surface: no cross-thread coordination on inject ack, log offset, or manifest write.

### §8.5 Why 1-process per session (vs. K-sessions per process)

- F1 (crash isolation): a PTY parser bug in session A cannot kill session B.
- D1–D3 (cdylib embed): an embedding host that wants exactly one session does not pay for a multi-session daemon.
- Operational simplicity: launchd/systemd unit = one supervisor; failure attribution is direct.

---

## §9 Phase plan

### §9.1 Phase 0 — Preconditions C1–C4 (must close before Phase 1)

| ID | Precondition | Owner | Success gate |
|---|---|---|---|
| C1 | E3 (RAM ≤ 10 MB) constitutional amendment process — confirm whether 10 MB or 15 MB is the legal cap; aigentry constitution amendment if needed | architect + orchestrator | written amendment in CONSTITUTION.md or evidence E3=10MB attainable |
| C2 | cdylib-in-tokio-host PoC (Rust supervisor compiled as cdylib, loaded by an embedding host process, spawn + inject + close successfully) | coder (Rust) | PoC repo + green CI run |
| C3 | Sidecar spike kill gate spec — written criteria for when "Rust sidecar" approach (vs. full Rust rewrite vs. Node retention) is killed (RSS thresholds, concurrency parity, PTY parity, etc.) | architect | docs/spec-sidecar-kill-gate.md |
| C4 | Bilingual ops cost analysis — Node 0.3.x retention vs. Rust sidecar transitional vs. Go full-rewrite, estimated person-week cost | architect + builder | docs/spec-bilingual-cost-analysis.md |

### §9.2 Phase 1 — Protocol + UDS/Named-Pipe + supervisor + manifest + log

- Implement NDJSON wire (M37'/M38').
- Implement UDS POSIX adapter + Named Pipe Windows adapter (C3, C4).
- Implement supervisor mode (single binary, single thread, jemalloc, M24/M31).
- Implement manifest (atomic rename, schema_version 1) + log.jsonl.
- Contract test suite (M25) green on Linux + macOS + WSL + Windows.
- 0.3.x → 1.0 bridge (J3) for inject/output/list subset.

### §9.3 Phase 2 — 3-OS adapter hardening + V4 cross-mesh + inbox + notification

- 3-OS parity test suite expansion (latency, ulimit, edge cases).
- V4 cross-mesh ADR (separate doc) implementation: contacts (V4-3), reachability (M40), inbox notification (M39).
- relay persistent process (T1, L1a/L2c/L3a/L4a).

### §9.4 Phase 3 — Persistent telepty-relay + AI-mediated triage opt-in

- Production relay deployment patterns (launchd/systemd unit shipping).
- AI-mediated triage receiver (V4 sketch §V4-5/§V4-11 expansion option).

### §9.5 Phase 4 — RAM/perf measurement gates → E3 hard invariant promotion

- Aggregate measurement: real-world N distributions, RSS percentiles, latency percentiles.
- Promote E3 (currently r1 amendment-eligible) to hard invariant if measurements support it.
- Decide on per-CPU-core hybrid / idle-suspended supervisor evolution (§8.3).

### §9.6 ETA dependencies

- C1–C4 gate Phase 1 entry. Phase 1 → Phase 2 entry depends on C2 (cdylib PoC) closure for D1–D3 to be implementable.
- Phase 2 → Phase 3 entry depends on V4 ADR acceptance (separate Phase 2 ADR doc).
- Phase 3 → Phase 4 entry depends on production relay deployment maturity.

---

## §10 Outstanding (TBD blanks)

| Area | Status | Owner | Resolution path |
|---|---|---|---|
| **Supervisor binary language** | TBD blank — Rust is leading candidate but the prior lock was revoked. Selection is evidence-gated. | architect + orchestrator | C2 (cdylib PoC) + C3 (sidecar kill gate) + C4 (bilingual cost) outcomes. If Rust passes all three, Rust is the language; if not, Go full-rewrite or Node-with-Rust-sidecar are revisited. |
| **Migration plan (0.3.x → 1.0)** | Separate plan ADR (#379), drafted after Phase 1 closure | builder + tester | Write `docs/adr/{date}-telepty-1-0-migration.md` once Phase 1 ships. |
| **V4 cross-mesh full design** | Separate Phase 2 ADR. Sketch exists at `docs/specs/2026-05-10-v4-cross-mesh-sketch.md`. | architect | Promote sketch → ADR after Phase 1 lands. |
| **E3 (RAM 10 vs 15 MB)** | r1 amendment-eligible per C1. | architect + orchestrator | Phase 0 C1 closure + (optional) constitution amendment. |
| **Per-CPU-core hybrid supervisor** | Phase 4+ option only. | architect | Only revisit if Phase 4 measurement shows pathological N. |
| **Phase 2 HMAC token (B4 / M11)** | Reserved wire field. | architect | Phase 2 V4 ADR addresses (M11 follow-up). |

---

## §11 Consequences

### §11.1 Positive

1. **Per-session crash isolation** — single PTY parser bug no longer kills all sessions (closes F-class reliability defect of 0.3.x).
2. **Issue #15 closure** — embedded library coexists cleanly with other supervisors (D1–D3 binding).
3. **Cross-OS uniformity** — single contract test, per-OS adapter (M25); Windows native gains parity (no WSL dependency, C4).
4. **V1 ∞ scaling** — RAM scales linearly per session, no shared bottleneck; N is bounded by infra not telepty (M29).
5. **"Stateless dumb pipe" principle restored** — supervisor is single-purpose (one PTY); aligns with boundary ADR §3.1 (mechanism-vs-content split), reverses 0.3.x violation.
6. **V4 forward-compat with zero new components** — M39/M40/V4 sketch reuses Q'''-bis surfaces (relay + manifest + NDJSON), no daemon, no broker (I3).
7. **NDJSON debuggability** — wire is human-readable in `tail -f log.jsonl`, contract test trivial, AI-CLI-friendly (claude/codex/gemini already produce JSON tool outputs).
8. **D1–D3 cdylib embed** — orchestrator app, brain, future hosts can embed the supervisor directly, removing daemon coordination from their concerns.

### §11.2 Negative

1. **Rewrite cost** — ~30% of 0.3.x code is replaced (daemon, IPC, manifest). Estimated 8–12 person-weeks at Phase 1 scope; bilingual ops cost analysis (C4) covers the migration window.
2. **Linear RAM scaling** — at N=100 supervisors, RSS = 500–800 MB. Acceptable on modern hosts but visibly higher than 0.3.x's shared-daemon footprint (which is what we were trying to escape).
3. **OS-specific adapter complexity** — UDS and Named Pipe diverge enough that the adapter layer is ~500–1000 LOC of platform-specific code. Mitigated by M25 contract test, but it is real surface.
4. **Transitional bilingual ops cost** — during the migration window, both 0.3.x (Node) and 1.0 (Rust/TBD) ship in parallel; ops needs to support both runtimes. C4 measures the cost.
5. **Manifest fan-out on disk** — N supervisors → N manifest dirs + N log files. Not a bottleneck below N=10000, but we should monitor inode usage on small filesystems.
6. **launchd/systemd-user complexity** — every supervisor needs a unit (or a generator that produces them). Operationally cleaner than daemon-per-tree but verbose.

### §11.3 Neutral

1. **V4 cross-mesh details deferred** — separate Phase 2 ADR. No risk to Phase 1 if V4 changes shape.
2. **Supervisor language TBD** — explicitly deferred per §10. Architecture decisions in this ADR (M28 Rust assumption) are flagged conditional.
3. **0.3.x sunset timing** — separate migration plan ADR. Phase 1 ships the bridge (J3); sunset is a later policy call.

---

## §12 Alternatives Considered

The Q''' family generated multiple grill-stage candidates. The architecture chosen (Q'''-bis) is one point in a designed space; the rejected alternatives are recorded here so the trade-offs are auditable.

### §12.1 Q''' (original) — single shared daemon, multi-process pool

- **Description**: replace the 0.3.x Node daemon with a Rust daemon that owns N PTYs in K worker processes (work-stealing pool).
- **Pros**: lower aggregate RAM than per-session (shared tokio runtime); familiar daemon-process model.
- **Rejected because**: (a) issue #15 (embed conflict) not solved — still one daemon competing with cdylib hosts; (b) crash blast radius reduced but not eliminated (a worker still owns ≥2 PTYs); (c) work-stealing across PTYs introduces non-trivial scheduler — bug surface; (d) does not enable D2 daemon-less embed.

### §12.2 D — daemon-less, in-process per CLI

- **Description**: each AI CLI links the supervisor as a library; no separate process.
- **Pros**: lowest RAM; no IPC.
- **Rejected because**: (a) loss of detach/reattach (A5) — when CLI exits, PTY dies; (b) loss of cross-CLI inject (orchestrator inject targeting claude session is impossible if claude owns the PTY in-process); (c) no cross-machine surface.

### §12.3 Q (multi-session per supervisor)

- **Description**: 1 supervisor per K sessions (group by tree or capacity).
- **Pros**: fewer processes; share tokio runtime overhead.
- **Rejected because**: (a) crash isolation degraded — K sessions share fate; (b) cdylib embed pays for K sessions when only 1 is wanted (D2 violation); (c) operational unit attribution becomes ambiguous.

### §12.4 I' (in-host supervisor, daemon for cross-machine only)

- **Description**: supervisor runs in-process for local sessions; a separate cross-machine daemon handles SSH multiplex.
- **Pros**: hybrid efficiency.
- **Rejected because**: introduces two architecture variants (in-process vs. out-of-process supervisor) — doubles test surface and contract complexity. Q'''-bis already gets the cross-machine benefit through relay (which is per-host, not a global daemon).

### §12.5 Y (shared daemon, per-session ephemeral child)

- **Description**: a thin daemon owns the manifest dir; each session spawn forks a short-lived child that owns the PTY; daemon survives child crashes.
- **Pros**: crash containment + central manifest authority.
- **Rejected because**: (a) the "thin daemon" still owns global state (manifest write coordination), reintroducing issue #15 conflict for cdylib hosts; (b) two-process per session (daemon + child) doubles operational unit count without RAM savings vs. per-session supervisor.

### §12.6 CC (CRDT-based cross-machine state sync)

- **Description**: every machine maintains a CRDT replica of session state; cross-machine inject is a CRDT operation.
- **Pros**: theoretical eventual consistency under partition.
- **Rejected because**: (a) CRDT for PTY data (an inherently linearizable byte stream) is a category error; (b) far too complex for Phase 1; (c) M40 binary reachability (V4 lock) explicitly rejects store-and-forward — CRDT presumes it.

### §12.7 N (no daemon, no supervisor — direct PTY per CLI invocation)

- **Description**: every `telepty inject` re-opens the target PTY by `<id>` lookup; no persistent process.
- **Pros**: simplest model on paper.
- **Rejected because**: (a) PTY ownership requires a process holding the master fd; without a supervisor, PTY dies on every CLI exit (A5 violation); (b) cross-machine inject would need to spawn a remote process per call (K1 latency violation).

### §12.8 O (orchestrator-side daemon)

- **Description**: orchestrator app owns all PTYs; CLI processes attach via orchestrator.
- **Pros**: single source of truth for sessions.
- **Rejected because**: (a) violates Article 3 역할 — orchestrator is a control tower, not a runtime owner; (b) couples L2 (session) to a specific orchestrator implementation; (c) breaks D1–D3 (other hosts can't embed); (d) breaks cross-OS / cross-terminal orthogonality.

### §12.9 Why Q'''-bis wins the trade-off

Q'''-bis is the **only** point that simultaneously satisfies (D1–D3, F1, K1, M29-unbounded, M40, M22, I3) without introducing a new architectural seam (extra daemon, CRDT layer, orchestrator coupling). Every alternative collapses on at least one binding requirement.

---

## §13 Open Questions — Phase 0 Preconditions C1–C4 (re-stated for trackability)

1. **C1 — E3 (RAM ≤ 10 MB) → ≤ 15 MB constitutional amendment process.** If Phase 0 measurement shows 10 MB unattainable (jemalloc floor + Rust runtime + tokio reactor > 10 MB on macOS arm64 even tuned), the aigentry constitution amendment process opens. Owner: architect + orchestrator. Closure artifact: amendment merged or evidence E3=10MB attainable.

2. **C2 — cdylib-in-tokio-host PoC (Phase 2 entry prerequisite).** Build the Rust supervisor as cdylib, load it from an embedding host (Node app, Swift app, Go app — pick at least 2 host languages), spawn + inject + close + cleanup successfully. If C2 fails, M28 must be re-stated for the chosen language; D1–D3 must be reassessed.

3. **C3 — Sidecar spike kill gate spec.** When does "Rust sidecar to a Node daemon" become unviable and force a full Rust rewrite? Need a written spec with thresholds: (a) RSS divergence > X% between sidecar and full-rewrite, (b) concurrency parity gap > Y, (c) PTY corner cases (resize, hangup, signal forwarding) not parity, (d) cross-OS adapter test fail rate > Z. Owner: architect.

4. **C4 — Bilingual ops cost analysis.** Quantify person-week cost of (a) Node 0.3.x retention during migration window, (b) Rust sidecar transitional model, (c) Go full-rewrite as alternative path. Goal: orchestrator + user can choose the migration shape with numeric evidence. Owner: architect + builder.

These four preconditions are **gating** — Phase 1 entry is denied until each has a closed artifact.

---

## §14 Self-Criticism (Article 13 — 비판적 + 건설적 + 객관적)

per Constitution Article 13, the author session (claude) records the strongest self-criticism it can muster against this ADR's own decisions. This section is **adversarial against the proposal**; it is the author honestly trying to break the proposal before reviewers do.

### §14.1 The RAM gamble is not free

- **Criticism**: M29 declares N unbounded "to infra limit". On a typical laptop (16 GB), N=1000 supervisors at 8 MB each = 8 GB RSS — half the machine's RAM gone to telepty. This is presented as "modern hosts have 16–64 GB" but laptops at the lower end are real. Practical N may be capped lower than M29 implies.
- **Mitigation honest assessment**: M30 (install-time ulimit guidance) does not address RAM. We need a separate ops doc on "expected N for this host class" before V1 ∞ promises ship to users.

### §14.2 The single-thread tokio assumption is fragile

- **Criticism**: M24 single-thread tokio per supervisor is justified because PTY I/O is serial. But once a supervisor accumulates non-PTY duties (V4 inbox notification source, V2 parent-tree event publisher, future cost/quota tracking via I2), the single thread can become a bottleneck. We may regret M24 in Phase 3.
- **Mitigation**: contract test should include latency under simulated mixed-duty load; if degradation observed, M24 is re-evaluated rather than over-engineered upfront.

### §14.3 Per-host relay = single point of failure for cross-machine

- **Criticism**: M23 makes relay persistent and per-host. If the relay crashes and auto-restart (L3a) takes 5 seconds, every cross-machine inject in that window is rejected (M40 binary). This is "fast-fail" elegance but it is also user-visible flakiness.
- **Mitigation acknowledged**: M40 explicitly rejects mailbox/store-and-forward, accepting this brittleness as a Phase 1 design choice. Phase 3+ revisit if production data shows it.

### §14.4 NDJSON is human-readable but not future-proof for binary payloads

- **Criticism**: M37' picks NDJSON for human readability and AI-CLI ergonomics. PTY output is inherently bytes (terminal escape sequences, ANSI, possibly UTF-8 with malformed sequences from buggy programs). Encoding raw bytes in JSON requires base64 or escape-heavy strings — a 4-byte CSI sequence becomes 12+ characters of JSON-escaped string. At high PTY throughput (a `find /` output, a `tail -f` of a busy log), the JSON overhead is non-trivial.
- **Mitigation**: M37' is locked for Phase 1, but a "kind-conditional binary frame" extension is technically compatible with M38' (add a `kind:"output_b64"` for binary payloads, or a `kind:"stream_open"` followed by raw bytes). Phase 4+ can promote a binary path if profiling shows JSON encoding is the bottleneck.

### §14.5 The supervisor language TBD is the largest unresolved risk

- **Criticism**: §10 lists "supervisor binary language" as TBD with Rust leading. M28 (`crate-type = ["cdylib", "rlib"]`) presupposes Rust. If C2 fails and the language flips to Go, M28 is replaced by Go's `c-shared` build mode and the entire embed story is re-derived. The ADR is structurally Rust-leaning while claiming neutrality.
- **Mitigation honest assessment**: this is a real defect of the current ADR. A revision should add a "language decision rubric" cross-referenced from M28, so when C2 closes, only one section needs amendment.

### §14.6 Phase 1 → Phase 2 dependency is steep

- **Criticism**: Phase 1 ships supervisor + manifest + UDS + Named Pipe + bridge to 0.3.x. Phase 2 adds 3-OS adapter hardening + V4 + relay + inbox + notification. Phase 2 is ~3x the surface of Phase 1, and the persistent relay (L1a/L2c/L3a/L4a) introduces a new lifecycle class that Phase 1 has not exercised. The phase boundary may collapse under integration cost.
- **Mitigation**: Phase 0 C2 (cdylib PoC) is a useful canary; the relay lifecycle should also have a Phase 0.5 spike to de-risk.

### §14.7 The boundary ADR (mechanism vs. content) drift

- **Criticism**: The boundary ADR (2026-05-05) ruled that telepty owns mechanism (transport, sessions) and devkit owns content (install, scaffold). M30 (install-time ulimit) edges into devkit territory: "install" is content, even if telepty's binary checks ulimit at first run. We should clarify that M30 is a *first-run check* (mechanism), not an *install-time hook* (content), to keep boundary clean.
- **Mitigation**: ADR text should say "first-spawn ulimit check" rather than "install-time" to align with boundary ADR.

### §14.8 The trade-off matrix in §12 is uneven

- **Criticism**: Some alternatives (Q''', D, Q) get detailed paragraph-level rejection; others (CC, N, O) get one-paragraph dismissals. A future reviewer may demand parallel structure (pros/cons/rejection table) for all 8 alternatives. We bias against the alternatives we already disliked.
- **Mitigation**: in r2, normalize §12 entries to a 3-row table per alternative.

---

## §15 Constitution Check (Article 4 위헌 심사)

### §15.1 Q1 — Does this serve closing the AI tech gap?

- **PASS**. Q'''-bis is the L2 surface that lets multi-CLI / multi-machine AI workflows scale beyond a single machine and a single CLI per machine. V1 ∞ + V4 cross-mesh are direct AI tech-gap features (multi-agent collaboration across machines).

### §15.2 Q2 — Whose role is this feature?

- **PASS**. telepty (L2 mechanism owner per boundary ADR §3.1) owns supervisor + manifest + IPC + relay + wire protocol. devkit owns install hooks (M30 first-spawn check is mechanism not content; §14.7). orchestrator consumes M39 inbox notification but does not own L2.

### §15.3 Q3 — Is this framework / library actually needed?

- **PASS**. Removing the daemon is a reduction, not an addition. Tailscale (L1) is reused. SSH (cross-machine transport) is reused. jemalloc is the only new dependency (linked statically) — needed for E3 RAM target. NDJSON / UDS / Named Pipe are OS-native; no library dependency.

### §15.4 Q4 — Does it work in all cross environments?

- **PASS** (with verification). C3+C4 require Linux + macOS + WSL + Windows native parity. M25 contract test enforces. Failure mode: Phase 1 ships only the OSes whose contract test is green; Windows-native may lag behind and ship in Phase 1.5.

### §15.5 Q5 — Does it avoid forcing "how" on users?

- **PASS**. Terminal app (aterm/iTerm/kitty/etc.) is explicitly orthogonal (§2.1 last bullet). User chooses the terminal; user chooses the AI CLI; telepty is a transparent L2.

### §15.6 Article-by-article alignment

| Article | Application | Status |
|---|---|---|
| 1 (경량) | Daemon-1 → Daemon-0 is a removal; jemalloc is the only new dep | PASS |
| 2 (크로스) | C3+C4 OS parity; terminal-orthogonal; CLI-agnostic | PASS |
| 3 (역할) | telepty=L2; orchestrator=control tower; aterm=terminal app — boundaries explicit | PASS |
| 5 (최선) | per-session supervisor is the best on (D1-D3, F1, K1, M40); not a workaround | PASS |
| 9 (독립) | each supervisor is independently operable; relay independent of supervisor | PASS |
| 13 (비판/건설/객관) | §14 self-criticism explicit | PASS |
| 17 (무의존) | OS-native IPC, no external broker, no plugin runtime | PASS |

---

## §16 History

- **r1 (2026-05-10)**: initial draft from grill outcomes (Q'''-bis architecture). Cross-LLM dispatch — claude session (this doc) + codex session (parallel). Proposed status; preconditions C1–C4 must close before flip to accepted. orchestrator best-of-both synthesis pending.

---

## §17 Appendix — Frame/manifest/log examples

### §17.1 Manifest example

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
    "type": "uds",
    "path": "/Users/duckyoungkim/.telepty/sessions/01HX.../sock"
  },
  "supervisor": {
    "pid": 12345,
    "binary_version": "1.0.0",
    "lang": "rust"
  },
  "cost_budget": null,
  "quota_class": null
}
```

### §17.2 Log example (`log.jsonl`)

```
{"ts":"2026-05-10T01:30:00.001Z","kind":"spawn","actor":"cli:duckyoungkim","trace_id":"01HX-S","cmd":["claude"],"pid":12346}
{"ts":"2026-05-10T01:30:00.412Z","kind":"output","seq":1,"size":42}
{"ts":"2026-05-10T01:30:01.103Z","kind":"inject","trace_id":"01HX-I-001","actor":"cli:duckyoungkim","size":8}
{"ts":"2026-05-10T01:30:01.108Z","kind":"output","seq":2,"size":8}
{"ts":"2026-05-10T01:30:30.001Z","kind":"signal","name":"SIGINT","actor":"cli:duckyoungkim"}
{"ts":"2026-05-10T01:30:30.050Z","kind":"output","seq":3,"size":4}
{"ts":"2026-05-10T01:30:30.099Z","kind":"delete","actor":"cli:duckyoungkim"}
```

### §17.3 Wire example — cross-machine inject (relay perspective)

```
# relay-A (sender side) frames sent over SSH stream to relay-B
{"v":1,"sid":"remote-codex@bob.tailnet","kind":"inject","data":"ls\n","trace_id":"01HX-X-007"}

# relay-B (receiver side) → supervisor X over local UDS
{"v":1,"sid":"01HX-X-suid","kind":"inject","data":"ls\n","trace_id":"01HX-X-007"}

# supervisor X → PTY → output streams back
{"v":1,"sid":"01HX-X-suid","kind":"output","seq":42,"data":"Cargo.toml\nsrc\n"}

# relay-B → relay-A (over SSH)
{"v":1,"sid":"remote-codex@bob.tailnet","kind":"output","seq":42,"data":"Cargo.toml\nsrc\n"}
```

### §17.4 Cross-machine reachability check (M40)

```
# pseudo (illustrative, non-executable)
fn reachable(target: TailscaleHandle) -> bool {
    tailscale_status_up()
        && ssh_reachable(target)
        && relay_running(target)
}
```

---

## §18 Self-check (Architect §6 7-item rubric)

1. **§1 Context explains why**: YES (§1.2 trigger lists D-1..D-4).
2. **§2 Decision has ≥ 2 alternatives + trade-offs**: YES (§12 lists 8 alternatives with rejection rationale).
3. **Each alternative selection / rejection is evidence-based**: YES (cross-machine survey 2026-05-09; boundary ADR; vision.md; issue #15 evidence).
4. **§11 Consequences includes failure modes**: YES (§11.2 negative; §14 self-criticism).
5. **§3.J Backward compat analyzed**: YES (J1, J2, J3 versioning + 0.3.x bridge).
6. **§15 Constitution Check filled**: YES (Q1–Q5 + Article-by-article table).
7. **§9 Phase plan / verification metrics measurable**: YES (E1–E4 measurement criteria, K1 latency budget, M25 contract test as the single gate).

Self-check: **7/7 PASS**. Submit to orchestrator for codex parallel synthesis.

---
