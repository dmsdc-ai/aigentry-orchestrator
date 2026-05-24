---
date: 2026-05-24
author: aigentry-orchestrator-claude (audit via Explore subagent)
purpose: Prior-art reference for telepty Rust unification (JS layer → Rust workspace)
status: reference (not a decision, not an ADR)
sources:
  - /Users/duckyoungkim/projects/aigentry-aterm (sibling project, full Rust)
  - /Users/duckyoungkim/projects/aigentry-telepty (target, hybrid JS+Rust)
---

# aterm Rust Patterns — Prior-Art Audit for Telepty Migration

## Why this doc exists

Telepty is mid-migration: `crates/telepty-supervisor-{core,bin}` is Rust, but daemon / CLI / cross-machine layers remain JS. The sibling `aterm` project is already a 3-crate pure-Rust workspace (~9.6k LOC). This audit extracts which aterm patterns telepty can directly reuse, which to adapt, and which to explicitly avoid — so the eventual telepty Rust unification stands on prior art rather than greenfield design.

This is not an ADR. No boundary decisions are locked here. Treat as a coding reference when telepty Phase 4+ dispatches land.

## Workspace topology comparison

| | aterm | telepty (current) |
|---|---|---|
| Workspace root | `Cargo.toml` (3 members) | `Cargo.toml` (2 members) |
| Crates | `aterm-{core, ipc, session}` | `telepty-supervisor-{core, bin}` |
| `workspace.package` | ❌ (per-crate independent) | ✅ (shared edition, rust-version, license) |
| `workspace.dependencies` | ❌ | ✅ (tokio, portable-pty, serde, clap, nix, time) |
| `[profile.release]` | default | `lto = "thin"`, `codegen-units = 1` |
| Async model | sync-first (threads + Condvar) | async-first (tokio rt+macros+sync+time+net+signal+fs) |
| LOC | ~9.6k | core ~3k (Phase 1 M1 spawn+observe) |

**Telepty's `workspace.package` + `workspace.dependencies` discipline is stricter and should be preserved.** aterm's per-crate dep choice fragmented version-pinning; telepty's centralized approach prevents drift across crates.

---

## 1. Atomic file writes — REUSE

**aterm pattern** (`aterm-core/src/session.rs:20-30`):
```rust
pub fn save_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    #[cfg(target_os = "windows")]
    { let _ = std::fs::remove_file(path); }  // Windows rename-over-existing workaround
    std::fs::rename(&tmp, path)
}
```

**Why reuse**: telepty already has the same need (manifest atomic writes via `tests/atomic_manifest.rs` — 5 tests including "concurrent_readers_never_observe_partial_json"). aterm's Windows workaround branch is the explicit pattern telepty's Phase 4 should follow.

**Adopt verbatim**.

---

## 2. NDJSON over UDS for local IPC — REUSE

**aterm pattern** (`aterm-ipc/src/server.rs:192-250`):
```rust
match serde_json::from_str::<SessionAction>(&line) {
    Ok(action) => {
        let response = dispatcher(action);
        let resp_json = serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"status":"Error","message":"serialize failed"}"#.to_string()
        });
        if writeln!(writer, "{}", resp_json).is_err() {
            break;
        }
    }
}
```

Schema (tagged enum):
```rust
#[serde(tag = "action")]
pub enum SessionAction {
    Inject { workspace: String, text: String, from: Option<String>, ... },
    ListWorkspaces,
    CreateWorkspace { name: String, cli: String, cwd: String },
    Subscribe { events: Vec<String> },
    WaitUntil { workspace: String, state: String, ... },
    ...
}
```

**Why reuse**: telepty's `src/bridge/supervisor-ipc.js` already uses NDJSON over UDS. Rust port = direct serde derive translation. No binary encoding (bincode/protobuf) complexity needed.

**Telepty divergence required**:
- **Add explicit version field** to envelope. aterm's "new variant breaks old clients" implicit versioning is fine for desktop app; cross-machine telepty needs explicit schema versioning.
- **Add `seq` / `correlation_id`** to responses. aterm's single-connection-per-client doesn't need request-response matching; telepty's multiplexed supervisor does.

---

## 3. Condvar-based state transitions — REUSE

**aterm pattern** (referenced in `aterm-core/tests/polling_event_tests.rs:40-71`):
```rust
type WorkspaceStatus = Arc<(Mutex<String>, Condvar)>;

// WaitUntil blocks the IPC handler until status reaches target.
// Cheaper than polling, plays nicely with subscriber gap detection.
```

**Why reuse**: telepty's supervisor has identical need — session state (starting → running → idle → closing → dead) consumed by reattach clients. Replacing polling with Condvar wakeup matches the existing `Notify` pattern already in `crates/telepty-supervisor-core/src/supervisor.rs`.

**Telepty caveat**: aterm stores state as `String`; telepty should use a typed enum (`SessionState`) for compile-time safety. Pattern = same; types = sharper.

---

## 4. UID-based UDS authentication — REUSE

**aterm pattern** (`aterm-ipc/src/auth.rs:20-45`):
```rust
#[cfg(target_os = "macos")]
fn verify_peer_macos(stream: &UnixStream) -> bool {
    use std::os::unix::io::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    unsafe { libc::getpeereid(fd, &mut uid, &mut gid) == 0 && uid == libc::getuid() }
}

#[cfg(target_os = "linux")]
fn verify_peer_linux(stream: &UnixStream) -> bool {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, ...) == 0 && cred.uid == libc::getuid() }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn verify_peer_unsupported(_stream: &UnixStream) -> bool {
    true  // Fallback: allow on unsupported platforms
}
```

**Why reuse**: telepty's supervisor.sock currently has no peer auth (relies on filesystem 0o600 perms). UID check at accept-time = defense-in-depth, prevents privilege-escalation if perms drift.

**Telepty extension**: Windows branch should not blanket-allow. When Phase 4 ships named-pipe support, use `GetNamedPipeServerProcessId` + token comparison.

---

## 5. Build metadata via `build.rs` — REUSE

**aterm pattern** (`aterm-core/build.rs:1-61`):
```rust
let hash = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output();
let dirty = Command::new("git").args(["diff", "--quiet"]).status();
let date = Command::new("date").args(["+%Y-%m-%d"]).output();

let current: u64 = fs::read_to_string(&build_number_path).unwrap_or(0);
let next = current + 1;
let _ = fs::write(&build_number_path, next.to_string());

println!("cargo:rustc-env=ATERM_GIT_HASH={}", hash);
println!("cargo:rustc-env=ATERM_DIRTY={}", dirty);
println!("cargo:rustc-env=ATERM_BUILD_DATE={}", date);
println!("cargo:rustc-env=ATERM_BUILD_NUMBER={}", next);
```

**Why reuse**: The v0.4.3 ↔ v0.3.5 daemon-version mismatch debacle (orchestrator task #450) would have been instantly diagnosable with git hash + dirty flag baked into binary. `telepty --version` printing `0.4.3 (abc1234, dirty)` makes root-cause analysis trivial.

**Adopt verbatim**.

---

## Anti-patterns — explicitly AVOID

### A1. Thread-per-IPC-connection

**aterm pattern** (`aterm-ipc/src/server.rs:48`):
```rust
std::thread::spawn(move || {
    for stream in listener.incoming() {
        std::thread::spawn(move || {
            handle_connection(stream, dispatcher.as_ref(), subs);
        });
    }
});
```

Works for aterm because desktop UI = low connection count.

**Why telepty avoids**: telepty supervisor will host tens-to-hundreds of concurrent sessions + cross-machine peer connections. OS thread per connection = unacceptable. **Use tokio tasks** (already telepty's chosen path).

### A2. In-memory-only state for long-lived daemon

aterm's workspace status lives only in `Arc<Mutex<String>>`. Restart = state loss, recovered from manifest on next launch.

**Why telepty avoids**: telepty supervisor is a daemon — uptime matters, crash recovery must preserve session state across restart. **Persist state to event log** (telepty already does this in `~/.telepty/sessions/<sid>/log.jsonl` per CHANGELOG A5).

### A3. Subprocess for HTTP (`curl`)

aterm pattern (`aterm-core/src/telepty_bridge.rs:25-37`):
```rust
Command::new("curl").args(["-s", "-o", "/dev/null", "-w", "%{http_code}", ...]).output()
```

aterm uses curl for health checks. Not portable (assumes curl in PATH, no Windows).

**Why telepty avoids**: telepty's cross-machine HTTP transport is core, not peripheral. Use `reqwest` or `hyper::client` for real cross-platform safety.

---

## Open questions (need follow-up before commit)

1. **Socket recovery flow on corruption**: If `~/.aigentry/aterm.sock` corrupts, does aterm rebind or fail? `aterm-ipc/src/server.rs:31` unlinks stale socket before bind, but error path unclear. Telepty Phase 4 needs explicit recovery.
2. **FileMailbox throughput ceiling**: aterm's PID-based file locks (`aterm-core/src/mailbox/mod.rs:45`) sufficient for desktop UI message rates. Telepty cross-machine outbox candidate? Need benchmark — bench harness not yet present in aterm.

---

## Telepty migration phase mapping (aterm-informed)

| Phase | Scope | aterm patterns to adopt |
|-------|-------|------------------------|
| 4 (Windows supervisor) | ConPTY + named pipes | A1 cross-platform `#[cfg]` patterns, A4 atomic write Windows branch |
| 5 (cross-machine.js → Rust) | HTTP transport + outbox + Tailscale auto-discovery | A2 NDJSON envelopes (cross-host wire schema), A3 Condvar for outbox drain wakeup, A5 build.rs |
| 6 (daemon.js → Rust) | HTTP server (axum), session table, broadcast bus | A4 UID auth (extend to Windows token), A1 atomic manifest |
| 7 (cli.js → Rust) | clap derive macros | Adopt aterm's npm postinstall + per-platform binary distribution |
| 8 (cleanup) | Delete `src/bridge/*`, `src/win-*`, JS layer | — |

---

## Final 5-pattern matrix (quick reference)

| # | Pattern | aterm citation | Telepty mod | Adopt verbatim? |
|---|---------|---------------|-------------|-----------------|
| 1 | Atomic file writes | `aterm-core/src/session.rs:20-30` | manifest, registry | ✅ |
| 2 | NDJSON over UDS | `aterm-ipc/src/server.rs:192-250` | supervisor-ipc Rust port | ⚠️ add version + correlation_id |
| 3 | Condvar state transitions | `aterm-core/src/pty.rs:11-12` | session state machine | ⚠️ use typed enum, not String |
| 4 | UID-based UDS auth | `aterm-ipc/src/auth.rs:20-45` | supervisor.sock + cross-machine UDS | ⚠️ extend Windows branch |
| 5 | `build.rs` metadata | `aterm-core/build.rs:1-61` | telepty-supervisor-bin + future telepty-bin | ✅ |

## Anti-pattern matrix

| # | Anti-pattern | Why aterm gets away | Why telepty must avoid |
|---|--------------|---------------------|----------------------|
| 1 | Thread-per-connection | Desktop UI, low concurrency | Daemon with N sessions × M peers |
| 2 | In-memory-only state | Restart on crash, manifest restore | Daemon uptime = product invariant |
| 3 | curl subprocess for HTTP | Health check only, single OS | Cross-machine transport is core |

---

*Compiled: 2026-05-24. Sources: 9.6k LOC aterm Rust workspace + ~3k LOC telepty supervisor crates + cross-cited CHANGELOG entries. Audit method: Explore subagent walking aterm-{core,ipc,session} + comparing to telepty supervisor and CHANGELOG documentation.*
