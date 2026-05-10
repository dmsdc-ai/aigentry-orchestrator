---
type: adr
status: proposed
revision: r1
date: 2026-05-10
author: codex
scope: telepty + orchestrator + aterm integration boundary
decision_type: one-way
tier: T2
trigger: "Q'''-bis grill lock for telepty L2 supervisor architecture; dispatched in parallel to claude + codex for best-of-both synthesis."
related:
  - "docs/adr/2026-05-05-telepty-devkit-boundary.md"
  - "docs/adr/2026-05-06-aterm-session-control-opt-3-prime.md"
  - "docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md"
  - "docs/specs/2026-05-10-v4-cross-mesh-sketch.md"
  - "~/projects/aigentry/docs/CONSTITUTION.md"
  - "~/.telepty/shared/82ecf41ecb845b5df6d7e5f7cd23b403bb8132da1f3b97bb99eb7e9729d2c012.md"
related_adrs:
  - "2026-05-05-telepty-devkit-boundary"
  - "2026-05-06-aterm-session-control-opt-3-prime"
status_policy: "proposed until preconditions C1-C4 pass; accepted only after orchestrator signoff"
reviewers_recommended: [claude, codex, gemini]
tags:
  - telepty
  - l2-session
  - q-prime-bis
  - supervisor
  - relay
  - daemonless
  - tailscale
  - ndjson
---

# ADR: telepty L2 Session Architecture (Q'''-bis)

## §1 Status, Context, Trigger

- **Status**: **proposed**.
- **Date**: 2026-05-10.
- **Decision-makers**: orchestrator.
- **Architectural label**: Q'''-bis.
- **Acceptance gate**: this ADR becomes `accepted` only after preconditions **C1-C4** pass or are explicitly waived by a successor ADR.
- **Codex draft path**: `docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-codex.md`.
- **Non-goal**: no implementation code, no commit, no migration PR in this draft.

### §1.1 Decision Summary

Adopt **telepty L2 supervisor architecture (Q'''-bis)**:

1. Split the stack into **L1 machine**, **L2 session**, and **L3 process**.
2. Remove the shared telepty daemon from the session critical path.
3. Run **one per-session supervisor process per telepty session**.
4. Run **one per-host telepty-relay process only for cross-machine traffic**.
5. Use filesystem manifests and structured logs as the discovery and audit backbone.
6. Use OS-native local IPC: UDS on POSIX, Named Pipe on Windows.
7. Use NDJSON as the wire frame for supervisor and relay traffic.
8. Keep the terminal application orthogonal: aterm, iTerm, kitty, ghostty, tmux, and other terminals are clients or display surfaces, not architectural owners of L2.

### §1.2 Binding Source of Truth

This r1 draft is generated from:

| Input | Role in this ADR | Binding level |
|---|---|---|
| `~/.telepty/shared/82ecf41ecb845b5df6d7e5f7cd23b403bb8132da1f3b97bb99eb7e9729d2c012.md` | Q'''-bis locked decisions, mandates M22-M40, requirements, phase plan | **Primary source** |
| `docs/adr/2026-05-05-telepty-devkit-boundary.md` | telepty as mechanism/runtime boundary, "stateless dumb pipe" direction | Binding predecessor |
| `docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md` | cross-machine transport evidence: Tailscale raw SSH, autossh, tmux, rejected network tools | Supporting evidence |
| `docs/specs/2026-05-10-v4-cross-mesh-sketch.md` | Phase 2 V4 forward-compat sketch: inbox, notification, reachability | Supporting sketch |
| `~/projects/aigentry/docs/CONSTITUTION.md` | Article 1, 2, 3, 9, 13, 17 evaluation | Constitutional check |

### §1.3 Trace Note on Requirement Count

The dispatch brief labels the requirements section **"31 Binding Requirements"**.
The same brief expands A-K into **39 concrete acceptance checks** when the visible counts are added:

```text
A8 + B4 + C4 + D3 + E4 + F3 + G3 + H3 + I3 + J3 + K1 = 39
```

This ADR preserves the source label **31 Binding Requirements** for compatibility with the orchestrator report format, while also listing every visible A-K acceptance check so no locked clause is silently dropped.
If the orchestrator later normalizes the count, the content of §4 is the canonical trace table.

---

## §2 Context

### §2.1 Current 0.3.x Model

telepty 0.3.x is organized around a shared daemon:

```text
CLI -> HTTP/WS -> daemon(:3848) -> session bridge / event bus / REST
```

This model worked for early local injection, but the grill identified three structural problems:

1. **Shared lifetime**: one daemon controls many sessions, so daemon version skew, daemon restart, and daemon ownership bugs affect unrelated sessions.
2. **Boundary drift**: a session bridge starts acting like a stateful service, contradicting the "stateless dumb pipe" principle in the telepty/devkit boundary ADR.
3. **V1 parallelism ceiling**: a single daemon becomes the choke point for unbounded session fanout, especially when sessions span multiple machines, operating systems, and embedded hosts.

The 2026-05-09 survey documents the user-visible version of the same pressure:

- cross-machine sessions lose inject reliability during network blips;
- stale local wrapper metadata leaks into remote session UX;
- bootstrap prompts and reconnect windows corrupt the target AI CLI;
- daemon mismatch noise persists when an older bundled daemon owns the port.

### §2.2 Why Q'''-bis Exists

Q'''-bis is not a transport tweak.
It is a **lifetime ownership correction**:

| Old axis | Old shape | Q'''-bis shape |
|---|---|---|
| Session lifetime | shared daemon owns many sessions | one supervisor owns one session |
| Cross-machine transport | daemon HTTP reachable or SSH wrapper patterns | relay mediates remote supervisor streams |
| Discovery | daemon state | atomic filesystem manifests |
| Audit | daemon logs and ad hoc state | per-session `log.jsonl` |
| Local IPC | HTTP/TCP loopback and mixed fallbacks | OS-native local IPC only |
| Embed | daemon conflict-prone | `cdylib`/`rlib` embedding path with conflict isolation |

### §2.3 Four-Axis Vision Pressure

The architecture must keep four future modes possible:

| Vision axis | Pressure on telepty | Q'''-bis answer |
|---|---|---|
| **V1 parallelism** | unlimited parallel AI CLI sessions | per-session supervisors scale linearly and isolate crashes |
| **V2 recursion** | session trees and child agents | `parent_id`, `trace_id`, tree-aware manifest metadata |
| **V3 single interface** | aterm and other terminals as entry points | terminal app remains orthogonal to L2 ownership |
| **V4 agent-mediated cross-mesh** | remote inbox, notifications, reachability | relay and NDJSON protocol stay forward-compatible |

### §2.4 Layer Separation

The locked layer split is:

```text
L1 machine    = Tailscale mesh fabric, stable address, cross-OS reachability
L2 session    = telepty Q'''-bis, addressable PTY abstraction
L3 process    = AI CLI process, e.g. claude / codex / gemini
Terminal app  = user choice, orthogonal display/control surface
```

This split means:

- Tailscale is not the session layer.
- SSH is not the session layer.
- aterm is not the session owner.
- tmux is not the telepty contract.
- AI CLI process state is L3, not L2.
- telepty owns the L2 PTY abstraction and routing contracts.

### §2.5 Boundary ADR Compatibility

ADR 2026-05-05 states that telepty owns transport/runtime primitives and protocol semantics, while devkit owns disk-side content and per-CLI integration.
Q'''-bis follows that boundary:

- telepty owns session supervisors, relay, IPC, manifests, logs, and wire protocol;
- devkit may still install hooks and scaffold files;
- aterm may still be a first-class UI endpoint;
- orchestrator may still dispatch and coordinate;
- none of those components own telepty's L2 lifetime.

### §2.6 Cross-Machine Survey Compatibility

The 2026-05-09 survey recommended:

```text
Tailscale raw SSH over MagicDNS + autossh + remote tmux
```

Q'''-bis keeps the winning idea at L1 and replaces the L2/L3 overload:

- **Tailscale** remains the stable machine fabric.
- **SSH** remains the remote authenticated stream primitive.
- **relay** becomes the long-lived per-host telepty endpoint.
- **supervisor** owns the remote PTY directly.
- **tmux** may still be useful for human fallback, but is no longer the L2 contract.

---

## §3 Decision

### §3.1 Adopt Q'''-bis

Adopt Q'''-bis as the V1 telepty L2 architecture:

```text
local CLI / embedder
  -> local IPC
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

### §3.2 Remove the Shared Daemon

The daemon count moves from **1 to 0** in the session critical path.

Binding consequences:

- no singleton daemon owns all sessions;
- no port 3848 listener is required by default;
- no daemon PID discovery is required to inject into a live session;
- daemon version mismatch cannot block unrelated sessions;
- crash isolation is per session, not per host.

### §3.3 Add Per-Session Supervisor

Each telepty session has exactly one supervisor process.

Responsibilities:

| Responsibility | Owner |
|---|---|
| Allocate and own PTY | supervisor |
| Spawn L3 process | supervisor |
| Inject bytes or structured input | supervisor |
| Emit output frames | supervisor |
| Resize PTY | supervisor |
| Send signals | supervisor |
| Write manifest atomically | supervisor |
| Append structured log | supervisor |
| Drain in-flight operations on termination | supervisor |

Non-responsibilities:

- it does not render UI;
- it does not store long-term memory;
- it does not perform AI triage in Phase 1;
- it does not mutate devkit/project scaffolding files.

### §3.4 Add Per-Host Relay for Cross-Machine Only

For cross-machine operations, each host runs one persistent `telepty-relay`.

Responsibilities:

| Responsibility | Phase |
|---|---|
| accept authenticated SSH stream from another trusted host | 3 |
| route frames to local supervisors by `sid` | 3 |
| multiplex multiple remote sessions over one relay process | 3 |
| enforce V4 reachability policy | 2+ |
| store V4 inbox messages after contact verification | 2+ |
| notify orchestrator via single-line inbox inject | 2+ |

Non-responsibilities:

- it does not own PTYs;
- it does not replace a supervisor;
- it does not store-and-forward messages while a receiver is offline;
- it does not become a shared daemon for local sessions.

### §3.5 Use Filesystem Manifest Discovery

Each session writes:

```text
~/.telepty/sessions/<id>/manifest.json
~/.telepty/sessions/<id>/log.jsonl
```

Manifest writes are atomic:

```text
write manifest.json.tmp
fsync file
rename manifest.json.tmp -> manifest.json
fsync directory where supported
```

The manifest schema version is `schema_version: 1`.

### §3.6 Use Structured Log Per Session

`log.jsonl` is append-only structured NDJSON.

Minimum event classes:

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

The log is not the source of discovery.
The manifest is the source of discovery.
The log is the source of audit and recovery explanation.

### §3.7 Use OS-Native Local IPC

Local supervisor control uses:

| Platform | IPC |
|---|---|
| macOS | Unix Domain Socket |
| Linux | Unix Domain Socket |
| WSL | Unix Domain Socket inside WSL boundary |
| Windows native | Named Pipe with owner ACL |

Binding rejection:

- no TCP loopback listener in Phase 1;
- no local HTTP server as the default IPC surface;
- no cross-platform abstraction that secretly degrades to localhost TCP.

### §3.8 Use NDJSON Wire Frames

The Phase 1 frame format is line-delimited JSON, UTF-8:

```json
{"v":1,"sid":"remote-codex","kind":"inject","data":"task X\n"}
{"v":1,"sid":"remote-gemini","kind":"output","data":"hello world\n"}
{"v":1,"sid":"remote-claude","kind":"resize","cols":120,"rows":40}
```

`kind` enum:

```text
inject / output / spawn / delete / resize / signal / ping / pong / error
```

Frame rules:

- `v` is required and starts at `1`;
- `sid` is required for session-scoped frames;
- `kind` is required;
- `data` is required only for data-carrying frame kinds;
- kind-conditional fields are explicit, e.g. `resize` requires `cols` and `rows`;
- receivers must fail closed on unknown required fields for a known kind;
- receivers may ignore unknown optional fields for forward compatibility.

### §3.9 Auth Phase 1

Phase 1 auth is intentionally small:

| Surface | Auth |
|---|---|
| POSIX local IPC | filesystem permission `0600` on socket path and parent session dir |
| Windows local IPC | Named Pipe owner ACL |
| Cross-machine | existing OpenSSH key authentication over Tailscale-reachable address |
| telepty-level token | none in Phase 1 |

Phase 2+ may add HMAC token authentication for inject operations.
That is explicitly not a Phase 1 requirement.

### §3.10 Single Binary Modes

Ship one binary with multiple modes:

```text
telepty supervisor ...
telepty relay ...
telepty cli ...
telepty embed ...
```

For the supervisor crate shape:

```toml
crate-type = ["cdylib", "rlib"]
```

This supports both standalone process mode and embedded host mode without inventing a second implementation.
The language remains **TBD** pending C1-C4, but Rust is the current leading candidate.

---

## §4 Constraints: "31 Binding Requirements" Trace Table

### §4.1 Requirement Index

The following table preserves every visible A-K clause from the locked source.

| ID | Requirement | Measurement or acceptance criterion |
|---|---|---|
| A1 | PTY core | supervisor can allocate and own PTY without shared daemon |
| A2 | Inject | local inject reaches target PTY with idempotency key support |
| A3 | Output | output stream emits ordered `output` frames |
| A4 | Signal | supervisor supports signal delivery to child process/process group |
| A5 | Detach/reattach | client can disconnect and reconnect to supervisor-owned PTY |
| A6 | ID | stable session ID maps to manifest path and IPC endpoint |
| A7 | List | `telepty list` discovers sessions from atomic manifests |
| A8 | Delete | delete terminates session and marks/removes manifest safely |
| B1 | User x machine identity | manifest carries user and machine identity |
| B2 | Parent ID | child sessions can record `parent_id` |
| B3 | Trace ID | operations can carry `trace_id` across routing hops |
| B4 | Inject auth Phase 2 | protocol leaves field/path for future auth token |
| C1 | UDS + SSH-as-IPC | local IPC is UDS/Named Pipe; cross-machine rides authenticated SSH stream |
| C2 | Tailscale compatibility | machine addressing works over tailnet stable names/IPs |
| C3 | Linux/Mac/WSL | Phase 2 hardening covers POSIX and WSL behavior |
| C4 | Windows native | Named Pipe path is first-class, not WSL-only |
| D1 | Library API | supervisor exposes library API for embed use |
| D2 | Daemon-less embed | host can embed without shared daemon |
| D3 | Conflict isolation | embedded supervisor cannot conflict with other sessions' IPC or state |
| E1 | Local inject latency | target < 1 ms local supervisor hop, measured p50/p95/p99 |
| E2 | Cold start | supervisor cold start < 500 ms |
| E3 | RAM budget | supervisor RSS <= 10 MB unless C1 amendment changes invariant |
| E4 | Idle CPU | idle CPU < 0.1% |
| F1 | Crash isolation | one supervisor crash does not kill unrelated sessions |
| F2 | Idempotent inject | repeated inject with same idempotency key is non-duplicating |
| F3 | Atomic discovery | list never sees partially-written manifest as valid |
| G1 | POSIX permission | socket/session dir mode prevents other users by default |
| G2 | No network listener default | no TCP listener for local session control in Phase 1 |
| G3 | Audit trail | `log.jsonl` records inject, output, signal, error, lifecycle |
| H1 | Self-supervision | launchd/systemd can restart supervisor/relay as configured |
| H2 | Disk policy | logs/manifests have retention and cleanup policy |
| H3 | Single binary | install surface remains one binary with modes |
| I1 | Tree-aware | parent/child metadata supports recursive orchestration |
| I2 | Cost/quota hooks | manifest/log schema has room for quota attribution |
| I3 | V4 forward-compat | relay and frame schema support inbox/reachability evolution |
| J1 | Wire protocol versioned | every frame has `v` |
| J2 | Manifest schema versioned | every manifest has `schema_version` |
| J3 | 0.3.x backward compatibility | migration plan keeps or bridges existing CLI expectations |
| K1 | Cross-machine inject latency | <= 20 ms RTT expected path; p99 < 100 ms measured |

### §4.2 Acceptance Gates by Category

| Category | Gate |
|---|---|
| Functional core | A1-A8 pass contract tests on macOS and Linux before Phase 1 acceptance |
| Identity/tracing | B1-B3 present in manifest/log; B4 reserved without shipping token |
| Cross-machine/platform | C1-C4 adapter tests exist before Phase 2 acceptance |
| Embedded | D1-D3 proven by cdylib-in-host PoC before Phase 2 entry |
| Performance | E1-E4 measured on reference Mac and Linux hosts |
| Reliability | F1-F3 covered by crash/duplicate/atomicity tests |
| Security | G1-G3 covered by permission and audit tests |
| Operability | H1-H3 documented in install and service templates |
| Composability | I1-I3 validated against V1/V2/V4 sketches |
| Compatibility | J1-J3 validated against migration ADR #379 |
| Cross-machine latency | K1 measured with relay over Tailscale + SSH |

---

## §5 Mandates M22-M40

### §5.1 Mandate Table

| Mandate | Binding decision | Rationale |
|---|---|---|
| M22 | OS-native local IPC: UDS POSIX, Named Pipe Windows; not TCP loopback | removes local network listener and resolves G2/M16 contradiction |
| M23 | Persistent telepty-relay per host; not SSH ControlMaster | relay is telepty-aware, inspectable, restartable, and cross-platform by contract |
| M24 | Single-process supervisor, single-thread tokio + jemalloc | lowest moving parts for per-session isolation and predictable memory |
| M25 | Protocol contract test is binding; per-OS adapter implementation is free | keep wire compatibility stable while allowing platform-specific internals |
| M26 | Cross-machine inject latency budget: 10-20 ms RTT + framing | prevents relay from becoming an unmeasured queueing layer |
| M27 | sccache + cargo workspace caching + selective LTO | mitigates Rust build-time cost if Rust remains chosen |
| M28 | Rust supervisor crate-type `cdylib` + `rlib` | supports embed plus standalone process from one implementation |
| M29 | Remove N=100 target; allow as many sessions as infrastructure permits | V1 parallelism must not bake in an arbitrary cap |
| M30 | Installer sets ulimit or gives explicit instructions | per-process architecture needs file/process budget surfaced early |
| M31 | Per-supervisor jemalloc tuning: `dirty_decay_ms:0,muzzy_decay_ms:0` | keeps many idle supervisors from retaining excess memory |
| M32 | Idle timeout default is unlimited, user configurable | sessions must not disappear unexpectedly |
| M33 | Spawn graceful: 3 retries with exponential backoff | handles transient CLI/PTY startup failures without silent loss |
| M34 | Crash graceful: launchd/systemd auto-restart + state recovery | supervisor/relay failure has a first-class recovery path |
| M35 | Discovery graceful: manifest cache + SSH config/Tailscale fallback | `list` works even when one discovery source is stale |
| M36 | Termination graceful drain on SIGTERM | in-flight inject/output operations finish or log explicit failure |
| M37' | Wire frame is NDJSON line-delimited JSON UTF-8 | simple stream framing, debuggable with shell tools |
| M38' | Frame schema versioned `v:1`, kind-conditional fields | allows additive evolution without ambiguity |
| M39 | V4 inbox notification is one orchestrator inject line | one channel, file inbox source of truth, debounced batching |
| M40 | V4 reachability is binary; no mailbox/store-and-forward | sender gets immediate reject when receiver unreachable |

### §5.2 Mandate Interactions

M22 and M23 are the load-bearing pair.
M22 rejects a local TCP listener.
M23 still permits cross-machine routing by putting SSH and relay at the machine boundary, not on localhost.

M29 and M31 are the scaling pair.
M29 refuses an arbitrary session cap.
M31 admits the cost and forces memory hygiene per supervisor.

M37' and M38' are the protocol pair.
M37' picks the frame transport.
M38' keeps the schema evolvable.

M39 and M40 are the V4 pair.
M39 defines how a reachable receiver is notified.
M40 rejects offline queueing as a Phase 2 concept.

---

## §6 Protocol Contract

### §6.1 Frame Envelope

Every frame has this base envelope:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | wire schema version |
| `sid` | string | session-scoped frames | session ID |
| `kind` | string enum | yes | frame kind |
| `trace_id` | string | optional Phase 1, recommended | operation trace |
| `op_id` | string | optional Phase 1, recommended | operation ID |
| `data` | string | kind-dependent | payload for inject/output/error |

### §6.2 Kind-Conditional Fields

| Kind | Required fields | Notes |
|---|---|---|
| `inject` | `sid`, `data` | may include `idempotency_key`, `from`, `trace_id` |
| `output` | `sid`, `data` | should include monotonic `seq` |
| `spawn` | `sid`, `argv` or `profile` | may include `cwd`, `env_policy` |
| `delete` | `sid` | may include `reason` |
| `resize` | `sid`, `cols`, `rows` | cols/rows positive integers |
| `signal` | `sid`, `signal` | signal is platform-normalized |
| `ping` | none | may include timestamp |
| `pong` | none | replies to ping |
| `error` | `code`, `data` | `data` is human-readable message |

### §6.3 Error Codes

Phase 1 error codes:

| Code | Meaning |
|---|---|
| `ERR_UNKNOWN_SESSION` | no manifest or live supervisor for `sid` |
| `ERR_BAD_FRAME` | JSON parse or schema validation failure |
| `ERR_UNSUPPORTED_VERSION` | frame `v` not supported |
| `ERR_PERMISSION_DENIED` | IPC permission/auth failure |
| `ERR_NOT_REACHABLE` | remote relay/supervisor unreachable |
| `ERR_DUPLICATE_OP` | idempotent replay detected and suppressed |
| `ERR_SPAWN_FAILED` | spawn failed after retry budget |
| `ERR_SHUTTING_DOWN` | supervisor is draining and rejects new work |

### §6.4 Idempotency

Inject idempotency is required for reliability:

```json
{"v":1,"sid":"remote-codex","kind":"inject","op_id":"01HX...","idempotency_key":"sha256:...","data":"task X\n"}
```

Supervisor behavior:

1. If the key is new, apply inject and append log event.
2. If the key is repeated and already completed, return success with duplicate marker.
3. If the key is repeated and in flight, return in-flight state or wait according to caller policy.
4. If the key repeats with different payload hash, reject as `ERR_BAD_FRAME`.

### §6.5 Backward Compatibility

The Phase 1 CLI may preserve existing user-facing commands:

```text
telepty list
telepty inject <id> "message"
telepty attach <id>
telepty read-screen <id>
telepty enter <id>
```

But the implementation behind those commands changes from daemon HTTP/WS to manifest discovery plus supervisor IPC.
Any compatibility shim that still speaks to 0.3.x must be explicitly marked as migration code and removed or retired by migration ADR #379.

---

## §7 Manifest and Disk Layout

### §7.1 Directory Layout

```text
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
```

### §7.2 Manifest Schema Version 1

Illustrative schema:

```json
{
  "schema_version": 1,
  "sid": "remote-codex",
  "user": "duckyoungkim",
  "machine": "macbook",
  "host": "macbook.tailnet.ts.net",
  "pid": 12345,
  "created_at": "2026-05-10T00:00:00Z",
  "updated_at": "2026-05-10T00:00:01Z",
  "cwd": "/Users/duckyoungkim/projects/aigentry-orchestrator",
  "argv_hash": "sha256:...",
  "parent_id": null,
  "trace_id": "01HX...",
  "ipc": {
    "kind": "uds",
    "path": "~/.telepty/sessions/remote-codex/supervisor.sock"
  },
  "status": "ready",
  "protocol": {
    "wire_version": 1
  }
}
```

### §7.3 Manifest Invariants

- `schema_version` is mandatory.
- `sid` must match the directory basename.
- `ipc.kind` is `uds` or `named_pipe`.
- `status` is one of `spawning`, `ready`, `draining`, `stopped`, `error`.
- partial writes are invalid by construction because readers only read `manifest.json` after atomic rename.
- stale manifests are handled by validating `pid`, IPC reachability, and optional heartbeat timestamp.

### §7.4 Disk Policy

Phase 1 must define defaults:

| File | Default retention |
|---|---|
| `manifest.json` | while session exists; tombstone optional after delete |
| `log.jsonl` | retained until explicit cleanup or size policy trigger |
| output data in logs | bounded or redacted according to configured audit policy |
| inbox files | V4 source of truth; separate retention policy |

The disk policy must be configurable.
Default behavior must not surprise users by deleting live session state.

---

## §8 Relay Topology and Lifecycle

### §8.1 Topology

Locked topology:

| Item | Decision |
|---|---|
| Relay count | one relay per host |
| Multi-user host | T1 initially; T2 escalation option later |
| Spawn | lazy spawn on first cross-machine inject |
| Idle timeout | unlimited by default, configurable |
| Restart | launchd/systemd auto-restart with state recovery |
| Discovery | manifest + SSH config/Tailscale fallback |

### §8.2 Relay Startup

Relay starts when:

1. user explicitly starts it;
2. installer configures service and host boots;
3. first cross-machine inject needs it and lazy spawn is enabled.

Relay startup writes:

```text
~/.telepty/relay/manifest.json
~/.telepty/relay/log.jsonl
```

### §8.3 Reachability

For V4 and remote inject, reachability is binary:

```text
Tailscale reachable + SSH auth succeeds + relay running = reachable
otherwise = unreachable
```

If unreachable:

- sender receives immediate reject;
- no mailbox queue is created;
- no store-and-forward retry is promised;
- the error should say which hop failed when safe to reveal.

### §8.4 Why Not SSH ControlMaster

SSH ControlMaster reuses SSH connections but does not understand telepty sessions.
It cannot:

- validate `sid` routing;
- emit telepty audit logs;
- enforce V4 inbox policy;
- expose relay health;
- maintain platform-neutral semantics for Windows;
- become the SSOT for reachability.

Therefore M23 mandates a persistent telepty-relay per host instead.

---

## §9 Security Model

### §9.1 Phase 1 Security

Phase 1 relies on OS ownership:

| Surface | Control |
|---|---|
| session directory | owner-only permission |
| UDS path | owner-only directory + socket permission |
| Named Pipe | owner ACL |
| remote hop | OpenSSH key auth |
| remote address | Tailscale stable identity/address |
| audit | per-session `log.jsonl` |

### §9.2 Explicit Rejections

Reject in Phase 1:

- TCP loopback listener as local IPC;
- unauthenticated local HTTP server;
- direct remote supervisor injection bypassing relay for V4 external inject;
- token auth bolted onto Phase 1 without a contract test;
- public relay services for AI CLI traffic;
- mailbox/store-and-forward for unreachable receivers.

### §9.3 Phase 2+ Security Hooks

Reserved for Phase 2+:

- HMAC token for inject authorization;
- per-contact ed25519 identity for V4;
- contact revocation;
- manual key rotation;
- inbox verification and promotion policy;
- additional audit redaction.

---

## §10 Performance and Capacity

### §10.1 Target Budgets

| Budget | Target |
|---|---|
| Local inject | < 1 ms supervisor hop |
| Cross-machine inject | <= 20 ms RTT expected path; p99 < 100 ms |
| Cold start | < 500 ms |
| Supervisor RSS | <= 10 MB unless C1 amendment changes target |
| Idle CPU | < 0.1% |
| Session count | unlimited up to infrastructure limits |

### §10.2 RAM Model

Q'''-bis accepts linear RAM:

```text
RAM ~= supervisor_RSS * session_count + relay_RSS_per_host
```

Source brief estimate:

```text
Rust supervisor: 5-8 MB * N
```

This is acceptable because:

- one session crash no longer threatens all sessions;
- V1 parallelism should be infrastructure-bound, not arbitrary-cap-bound;
- Phase 4 explicitly reopens RAM/perf evolution;
- per-CPU-core hybrid and idle-suspended supervisors remain future paths.

### §10.3 E3 Risk

The brief locks E3 as `RAM <= 10MB`, but also requires C1:

```text
C1: E3 (RAM <= 10MB) -> <= 15MB constitutional amendment procedure
```

Therefore E3 is a **precondition risk**, not a proven invariant.
This ADR must not claim the RAM target is already measured.

### §10.4 Build Cost Mitigation

If Rust remains the implementation language:

- use `sccache`;
- cache the cargo workspace in CI;
- apply LTO selectively, not globally by default;
- keep protocol contract tests fast and platform adapter tests targeted;
- do not make full cross-OS perf tests a pre-merge gate for every doc-only change.

---

## §11 Consequences

### §11.1 Positive Consequences

| Positive | Why it matters |
|---|---|
| Per-session isolation | one crashed supervisor does not kill unrelated sessions |
| Issue #15 closure path | no shared daemon port owner to mismatch globally |
| Cross-OS uniformity | OS-specific IPC is explicit and contract-tested |
| V1 unbounded scaling | no baked-in N=100 cap |
| Boundary restoration | telepty is L2 mechanism, not a shared app daemon |
| Better audit | each session has its own structured log |
| Embed path | `cdylib`/`rlib` allows host integration without daemon conflict |
| V4 compatibility | relay can grow inbox/reachability without replacing L2 |

### §11.2 Negative Consequences

| Negative | Mitigation |
|---|---|
| Rewrite cost | phase plan gates and migration ADR #379 |
| Linear RAM cost | jemalloc tuning, measurement gates, Phase 4 hybrid path |
| More OS adapter work | protocol contract tests plus per-OS adapter freedom |
| Transitional bilingual ops cost | C4 analysis before language lock |
| More process management | launchd/systemd templates, ulimit install check |
| More disk artifacts | disk policy and cleanup command |

### §11.3 Neutral Consequences

- V4 cross-mesh details remain a separate Phase 2 ADR.
- Supervisor binary language remains TBD.
- The terminal app remains a user choice.
- Existing `telepty` commands may remain stable while implementation changes.
- tmux remains useful as a human fallback but is not an L2 requirement.

### §11.4 Article 13 Self-Criticism

This ADR is intentionally critical of its own decision:

1. **Requirement count mismatch**: the source says 31, the visible checks expand to 39. This draft exposes the mismatch rather than hiding it.
2. **RAM target uncertainty**: E3 is plausible only after measurement. C1 exists because the 10 MB target may be too strict.
3. **Language uncertainty**: Rust is attractive for memory/control, but the lock is revoked. The binary language must be evidence-gated.
4. **Windows risk**: Named Pipe parity is not a checkbox. It needs native tests, not WSL substitution.
5. **Latency risk**: K1 requires measured p99 over actual Tailscale + SSH + relay paths. Architecture alone cannot prove it.
6. **Operational cost**: many supervisors are simpler conceptually but increase process count, ulimit pressure, and service observability needs.

The constructive answer is the phase plan: prove the risky pieces before accepting the ADR as implementation lock.

---

## §12 Alternatives Considered

### §12.1 Q''' Original

**Shape**: predecessor to Q'''-bis, retaining too much shared-daemon or ambiguous relay/supervisor boundary.

**Rejected because**:

- it did not fully remove singleton daemon failure modes;
- it left embed conflict unresolved;
- it did not sharpen local IPC rejection of TCP loopback;
- it did not fully align with issue #15 closure.

**What survived into Q'''-bis**:

- per-session ownership direction;
- relay as cross-machine component;
- manifest/log as durable discovery/audit primitives.

### §12.2 D Candidate

**Shape**: shared daemon as central control plane.

**Rejected because**:

- daemon mismatch remains global;
- crash blast radius remains too large;
- V1 scaling bottleneck remains;
- "stateless dumb pipe" principle remains violated.

### §12.3 Q Candidate

**Shape**: host-level session manager with stronger daemon semantics.

**Rejected because**:

- host-level manager still centralizes failure;
- per-session resource accounting remains opaque;
- embed conflicts remain likely;
- local IPC still tends toward a service endpoint instead of session endpoint.

### §12.4 I' Candidate

**Shape**: terminal-app-integrated ownership path.

**Rejected because**:

- it couples L2 to aterm/iTerm/kitty/etc.;
- terminal choice must remain orthogonal;
- cross-machine and headless sessions cannot depend on GUI terminal availability;
- Article 3 role separation would blur.

### §12.5 Y Candidate

**Shape**: TCP loopback as local IPC.

**Rejected because**:

- M22 explicitly rejects it;
- local TCP listener violates no-network-listener default;
- loopback TCP inherits firewall/port/security ambiguity;
- UDS/Named Pipe give better owner-bound local semantics.

### §12.6 CC Candidate

**Shape**: SSH ControlMaster instead of telepty-relay.

**Rejected because**:

- ControlMaster is a connection reuse feature, not a telepty routing component;
- it has no session manifest/log semantics;
- it cannot enforce V4 inbox consent;
- it does not solve Windows-native parity.

### §12.7 N Candidate

**Shape**: fixed N=100 target.

**Rejected because**:

- the user vision is V1 unbounded parallelism;
- real limit should be infrastructure and measured resource budget;
- arbitrary caps become product constraints before evidence exists.

### §12.8 O Candidate

**Shape**: mailbox/store-and-forward for unreachable receivers.

**Rejected because**:

- M40 requires immediate reject when unreachable;
- offline queueing creates consent, expiry, replay, and privacy policy before V4 needs it;
- file-based inbox is the source of truth only after receiver relay accepts the message.

### §12.9 Tailscale SSH Mode

**Shape**: use Tailscale SSH protocol mode instead of raw SSH over tailnet.

**Rejected because**:

- the survey found daemon restart kills existing Tailscale SSH sessions;
- port 22 semantics are less flexible;
- raw SSH over tailnet preserves existing OpenSSH behavior and composes better with relay.

### §12.10 Public Relay Systems

**Shape**: tmate-like public relay.

**Rejected because**:

- AI CLI sessions may contain code, prompts, credentials, and private work context;
- relay trust posture is wrong for default telepty;
- Tailscale + SSH gives private reachability without third-party terminal relay plaintext exposure.

---

## §13 Open Questions and Preconditions

### §13.1 C1: E3 RAM Amendment

Question:

```text
Should E3 remain RAM <= 10 MB, or should the constitutionally accepted invariant become <= 15 MB?
```

Required evidence:

- supervisor RSS on macOS idle;
- supervisor RSS on Linux idle;
- supervisor RSS after inject/output churn;
- supervisor RSS with N = 1, 10, 50, 100;
- memory retained after session deletion.

Acceptance:

- if <= 10 MB is met, keep E3;
- if 10-15 MB is met and tradeoff is justified, run amendment procedure;
- if > 15 MB, revisit architecture or implementation language.

### §13.2 C2: cdylib-in-tokio-host PoC

Question:

```text
Can the supervisor core run as a cdylib inside a Tokio host without runtime conflicts?
```

Required evidence:

- embed host starts and stops supervisor core;
- no nested runtime panic;
- clean teardown;
- two embedded sessions isolated;
- no conflict with standalone supervisor.

Phase dependency:

- Phase 2 entry prerequisite.

### §13.3 C3: Sidecar Spike Kill Gate Spec

Question:

```text
What measured thresholds kill the sidecar/supervisor approach before full rewrite?
```

Kill gate candidates:

- RSS exceeds accepted E3 target;
- concurrency cannot reach target N under ulimit policy;
- PTY behavior differs from 0.3.x in compatibility-critical ways;
- local inject latency misses by more than agreed margin;
- Windows native adapter cannot meet parity.

### §13.4 C4: Bilingual Ops Cost Analysis

Question:

```text
Should implementation stay Node, move Rust sidecar, or choose Go full rewrite?
```

Compare:

| Option | Pros | Risks |
|---|---|---|
| Node maintained | lowest migration cost | RAM, daemon legacy, native IPC/perf complexity |
| Rust sidecar | best systems fit, cdylib path | bilingual build/release/debug cost |
| Go full | simpler static binary | PTY/Windows/native embed unknowns, less existing fit |

Decision rule:

- do not lock language in this ADR;
- use precondition evidence;
- preserve single-binary and embed requirements regardless of language.

---

## §14 Phase Plan

### §14.1 Phase Overview

| Phase | Work | Exit criteria | Indicative ETA |
|---|---|---|---|
| 0 | Preconditions C1-C4 | language and RAM risk reduced | 2-5 days |
| 1 | Protocol + IPC + supervisor + manifest + log | local sessions work daemonless | 1-2 weeks |
| 2 | 3-OS adapter hardening + V4 cross-mesh + inbox + notification | macOS/Linux/Windows contracts pass; V4 ADR lands | 2-3 weeks |
| 3 | Persistent telepty-relay + optional AI-mediated triage | cross-machine relay default path works | 1-2 weeks |
| 4 | RAM/perf measurement gates and E3 promotion | metrics decide invariant or amendment | 3-5 days |

ETA is an order-of-magnitude planning signal, not a delivery commitment.

### §14.2 Phase 0: Preconditions

Tasks:

1. run RAM spike for supervisor candidate;
2. run cdylib-in-host PoC;
3. define sidecar kill gates;
4. compare Node/Rust/Go operational cost.

Deliverables:

- precondition report;
- recommendation on supervisor binary language;
- E3 amendment recommendation if needed;
- go/no-go for Phase 1 rewrite.

### §14.3 Phase 1: Local Core

Tasks:

1. define NDJSON schema and contract tests;
2. implement POSIX UDS adapter;
3. implement single-session supervisor;
4. write manifest atomically;
5. append `log.jsonl`;
6. implement `list`, `inject`, `output`, `resize`, `signal`, `delete`;
7. implement idempotent inject;
8. implement launchd/systemd templates or documented manual service wrapper.

Exit:

- no shared daemon required for local session lifecycle;
- local inject < 1 ms measured on reference host or exception filed;
- manifest discovery stable under concurrent spawn/delete tests.

### §14.4 Phase 2: Platform and V4 Foundations

Tasks:

1. harden macOS adapter;
2. harden Linux adapter;
3. harden Windows native Named Pipe adapter;
4. land V4 cross-mesh ADR;
5. implement file-based inbox source of truth;
6. implement one-line orchestrator notification;
7. implement binary reachability reject.

Exit:

- POSIX and Windows tests pass;
- V4 notification format is exactly:

```text
[INBOX from <alias>] <title <= 50 chars>
```

- no mailbox/store-and-forward semantics are introduced.

### §14.5 Phase 3: Persistent Relay

Tasks:

1. implement per-host relay;
2. route SSH stream frames to local supervisor IPC;
3. write relay manifest/log;
4. add launchd/systemd restart with state recovery;
5. add discovery fallback via manifest cache, SSH config, and Tailscale names;
6. optionally prototype AI-mediated triage after relay baseline.

Exit:

- cross-machine inject works through relay;
- K1 latency measured;
- relay restart recovers session routing without PTY loss.

### §14.6 Phase 4: Measurement Gates

Tasks:

1. measure RSS for N sessions;
2. measure idle CPU;
3. measure cold start;
4. measure local and remote inject latency;
5. decide E3 promotion or amendment;
6. decide whether hybrid per-CPU-core or idle-suspended supervisor work is needed.

Exit:

- E1-E4 and K1 have data;
- E3 is either promoted to hard invariant or amended by explicit procedure.

---

## §15 Implementation Handoff

### §15.1 Owned Components

| Component | Owner repo | Notes |
|---|---|---|
| supervisor | aigentry-telepty | L2 session owner |
| relay | aigentry-telepty | cross-machine per-host process |
| CLI compatibility | aigentry-telepty | preserve user-facing command surface where possible |
| devkit scaffolding | aigentry-devkit | no change to boundary |
| aterm UI | aigentry-aterm | terminal app remains orthogonal |
| orchestrator dispatch | aigentry-orchestrator | consumes telepty commands and V4 notifications |

### §15.2 Initial Contract Tests

Required tests:

| Test | Purpose |
|---|---|
| `protocol/inject.v1` | validates inject frame schema |
| `protocol/output.v1` | validates output ordering |
| `protocol/resize.v1` | validates kind-conditional fields |
| `manifest/atomic-write` | reader never sees partial manifest |
| `ipc/uds-permission` | owner-only access on POSIX |
| `ipc/named-pipe-acl` | owner-only access on Windows |
| `inject/idempotent` | duplicate op suppressed |
| `supervisor/crash-isolation` | one crash does not kill another session |
| `relay/reachability` | unreachable remote rejects immediately |
| `perf/local-inject` | local hop budget measurement |
| `perf/cross-machine-inject` | K1 measurement over Tailscale + SSH + relay |

### §15.3 Migration ADR Dependency

Migration from 0.3.x to 1.0 is a separate ADR:

```text
Migration plan (0.3.x -> 1.0): separate plan ADR #379, after Phase 1 completes
```

This draft only requires that migration not be forgotten.
It does not specify the compatibility shim lifetime.

---

## §16 Constitutional Check

| Article | Result | Reason |
|---|---|---|
| Article 1 Lightweight | PASS with risk | removes singleton daemon but adds many supervisors; RAM measured in Phase 4 |
| Article 2 Cross-Everything | PASS | L1/L2/L3 split explicitly covers machine, OS, session, AI CLI |
| Article 3 Role Separation | PASS | terminal apps and devkit remain outside L2 ownership |
| Article 5 Best-First | PASS | chooses root lifetime fix instead of daemon patching |
| Article 7 Interoperability | PASS | NDJSON, SSH, UDS/Named Pipe, versioned schemas |
| Article 9 Independence | PASS | telepty can run standalone without orchestrator/aterm/devkit |
| Article 13 Critical/Constructive/Objective | PASS | risks and preconditions explicitly recorded |
| Article 15 SSOT Contracts | PENDING | protocol and manifest contracts must be registered during Phase 1 |
| Article 17 Zero External Dependency | PASS with note | Tailscale/OpenSSH are integration surfaces; local core does not require third-party terminal plugin |

---

## §17 Final Decision Record

### §17.1 Binding Decisions

1. Q'''-bis is the proposed L2 architecture.
2. Shared daemon is removed from session critical path.
3. Per-session supervisor owns PTY.
4. Per-host relay exists only for cross-machine traffic.
5. Filesystem manifest is the discovery source of truth.
6. Structured per-session log is the audit source.
7. Local IPC is UDS/Named Pipe, not TCP loopback.
8. Wire protocol is NDJSON with `v:1`.
9. Phase 1 auth is OS permission + SSH key auth only.
10. Single binary mode shape is required.
11. Supervisor language remains TBD until C1-C4.
12. Migration plan is separate after Phase 1.

### §17.2 Explicit TBD Blanks

| TBD | Owner | When resolved |
|---|---|---|
| supervisor binary language | orchestrator + telepty implementer | Phase 0 |
| E3 10 MB vs 15 MB target | orchestrator | Phase 0/4 |
| exact manifest JSON Schema file path | telepty implementer | Phase 1 |
| exact NDJSON contract fixture path | telepty implementer | Phase 1 |
| 0.3.x migration shim lifetime | migration ADR #379 | after Phase 1 |
| V4 cross-mesh full details | Phase 2 ADR | Phase 2 |

### §17.3 Non-Binding Recommendations

- Prefer Rust unless C1-C4 evidence rejects it.
- Keep supervisor process code small enough to audit.
- Keep relay feature set narrow until V4 ADR lands.
- Write contract tests before broad implementation.
- Measure before optimizing session count.

---

## §18 History

- **r1 2026-05-10**: initial Codex draft from Q'''-bis locked brief. Status `proposed`. Includes all visible A-K requirements, mandates M22-M40, C1-C4 preconditions, Phase 0-4 plan, alternatives, and Article 13 self-criticism.
