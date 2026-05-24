---
date: 2026-05-24
reviewer: aigentry-architect-phase5-review (codex)
target: state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md
verdict: REJECT_AND_REVISE
---

# Phase 5 Dispatch Spec — Codex Review

## Verdict

REJECT_AND_REVISE. The direction is sound, but the draft should not be live-dispatched until three fatal gaps are fixed: (1) it forbids `cli.js` edits while requiring an acceptance path that currently lives only in `cli.js`, (2) it says "port `cross-machine.js`" but omits SSH/legacy peer parity that is covered by the existing test suite, and (3) the bridge shim has no binary resolution, npm distribution, or process protocol contract. These are spec defects, not implementation details.

## Findings by axis

### Axis A — Architectural soundness

- **[BLOCKER]** Acceptance requires a `cli.js` route the spec forbids touching
  - Evidence: `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:68` requires the existing cross-host inject test to pass "when CLI dispatches via the new Rust path"; the same spec says not to touch `cli.js` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:89`. The current CLI resolves the target at `/Users/duckyoungkim/projects/aigentry-telepty/cli.js:1711` and posts directly to the daemon at `/Users/duckyoungkim/projects/aigentry-telepty/cli.js:1780`, bypassing `cross-machine.js`.
  - Why: Replacing `cross-machine.js` with a Rust subprocess shim will not affect `telepty inject <id>@<host>:<port>` as currently tested. The acceptance criterion is impossible under the stated do-not-touch boundary.
  - Suggested fix: Either explicitly allow a narrow `cli.js` edit for the `<id>@<host>:<port>` route, or rewrite the acceptance criterion to cover only `connect-http`/peer discovery through `cross-machine.js` and defer direct CLI injection routing.

- **[BLOCKER]** The proposed Rust crate omits SSH and legacy peer parity from a file it claims to port
  - Evidence: The proposed layout has `http_transport.rs` but no SSH transport at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:113`-`119`, and the implementation steps do not include SSH parity at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:159`-`175`. The current JS exports SSH-facing APIs at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:472`-`497`, implements SSH connect/inject/shared-context at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:100`-`289`, and has regression tests for legacy SSH peers at `/Users/duckyoungkim/projects/aigentry-telepty/test/cross-machine-ssh-routing.test.js:44`-`120`.
  - Why: `npm test` includes `test/cross-machine-ssh-routing.test.js` in `/Users/duckyoungkim/projects/aigentry-telepty/package.json:36`. A bridge that only handles HTTP/outbox will regress existing SSH routing.
  - Suggested fix: Choose one explicit migration rule: either keep the existing SSH code path in `cross-machine.js` and bridge only HTTP/outbox calls to Rust, or add `ssh_transport.rs` plus parity tests for `connect`, `remoteInject`, `remoteEnsureSharedContext`, `listSshPeers`, and `getSshPeerHandle`.

- **[CONFIRMED]** The crate boundary is in the right repository and should not be split prematurely
  - Evidence: The spec scopes the crate to cross-machine transport, peer registry, addressing, tailscale stub, and outbox at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:107`-`126`. The Constitution warns against unnecessary abstraction at `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:21`-`28`.
  - Why: `crates/telepty-cross-machine/` is cohesive for this phase. Splitting outbox into its own crate would add an ownership boundary before there is more than one consumer.
  - Suggested fix: Keep outbox as a concrete module inside the crate, but tighten its concurrency and resource limits as noted below.

### Axis B — Rust idiomatics

- **[MAJOR]** `Condvar` is the wrong wakeup primitive for a tokio outbox worker
  - Evidence: The spec asks for "Condvar state transitions" at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:51` and "tokio task with exp-backoff, Condvar wakeup" at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:167`. The prior-art report says telepty is async-first at `docs/reports/2026-05-24-aterm-rust-patterns-for-telepty.md:28` and already has a `Notify` pattern at `docs/reports/2026-05-24-aterm-rust-patterns-for-telepty.md:102`; tokio's `sync` feature is already enabled at `/Users/duckyoungkim/projects/aigentry-telepty/Cargo.toml:15`.
  - Why: Blocking a runtime worker on `std::sync::Condvar` is an avoidable async footgun.
  - Suggested fix: Replace the spec text with `tokio::sync::Notify` for "new message" wakeups and `tokio::time::sleep_until` for backoff scheduling.

- **[MAJOR]** The outbox filename scheme conflicts with the idempotency requirement under concurrent callers
  - Evidence: The spec says unreachable injects enqueue to `~/.telepty/outbox/<peer>/<seq>.json` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:70`, but also requires same-`msg_id` idempotency at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:73`. The bridge design can create independent processes per call via `spawnSync` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:147`-`150`.
  - Why: A sequence filename requires scan-then-write to detect duplicates; two bridge processes can race and enqueue the same message twice.
  - Suggested fix: Key the durable filename by `msg_id` or use atomic `create_new` on an idempotency marker before writing a sequence file. Add a concurrent enqueue test with two processes, not only two calls in one process.

- **[MINOR]** Cite telepty's stronger atomic write pattern, not only aterm's simpler pattern
  - Evidence: The spec points to aterm atomic writes at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:49`, while telepty already has `tmp + fsync(tmp) + rename + fsync(parent_dir)` in `/Users/duckyoungkim/projects/aigentry-telepty/crates/telepty-supervisor-core/src/manifest.rs:117`-`131`. The aterm report's example only writes and renames at `docs/reports/2026-05-24-aterm-rust-patterns-for-telepty.md:39`-`45`.
  - Why: For a persistent outbox and `peers.json`, the in-repo pattern is more durable and should be the coding reference.
  - Suggested fix: Update the spec to say "use `manifest::write_atomic` style: fsync temp file and parent directory after rename."

- **[CONFIRMED]** The top-level HTTP dependency direction is appropriate for this phase
  - Evidence: The spec adds only `reqwest` with `json` and `rustls-tls` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:138`-`141` and says no server crate is needed at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:208`. The existing server endpoints are owned by `daemon.js`, for example `/api/health` at `/Users/duckyoungkim/projects/aigentry-telepty/daemon.js:224`-`226`, `/api/sessions` at `/Users/duckyoungkim/projects/aigentry-telepty/daemon.js:1409`-`1417`, and `/api/sessions/:id/inject` at `/Users/duckyoungkim/projects/aigentry-telepty/daemon.js:2069`-`2077`.
  - Why: Phase 5 is a client-side cross-machine crate. `axum` or a top-level `hyper` dependency would be scope creep.
  - Suggested fix: Keep this requirement, with a wording tweak in the do-not list so "axum or hyper" are clearly prohibited, not listed as allowed exceptions.

### Axis C — Scope realism

- **[MAJOR]** The 5-10 day estimate is aggressive after the hidden parity work is included
  - Evidence: The estimate is 5-10 working days at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:6`. The step list puts integration test, bridge shim, full npm regression, Snyk, changelog, and report into steps 11-17 at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:169`-`175`. The existing npm test command is broad and includes cross-host, SSH routing, Windows tests, and bridge tests at `/Users/duckyoungkim/projects/aigentry-telepty/package.json:36`.
  - Why: The visible Rust work is not the whole job; the bridge, packaging, CLI route, SSH parity decision, and test-suite compatibility are migration work.
  - Suggested fix: Split the plan into two dispatches or extend the estimate: Phase 5a for crate + HTTP peer + outbox library tests, Phase 5b for bridge/CLI/package integration and full npm regression.

- **[CONFIRMED]** Steps 1-6 are realistic if the scope is narrowed to HTTP peer parity
  - Evidence: The existing HTTP peer code is compact and localized in `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:352`-`469`, and workspace registration follows the existing two-member pattern in `/Users/duckyoungkim/projects/aigentry-telepty/Cargo.toml:1`-`24`.
  - Why: Scaffold, addressing, peers, errors, and reqwest client calls can plausibly land quickly if they are not also required to solve CLI routing and SSH parity.
  - Suggested fix: Make the scope boundary explicit and do not count bridge/packaging as "just one final day."

### Axis D — Bridge shim risk

- **[BLOCKER]** The bridge has no binary resolution or npm distribution contract
  - Evidence: The draft shim hardcodes `spawnSync('telepty-cross-machine-bin', ...)` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:147`-`150`. The package exposes only JS bins at `/Users/duckyoungkim/projects/aigentry-telepty/package.json:5`-`9` and includes no built `target/` artifacts in package files at `/Users/duckyoungkim/projects/aigentry-telepty/package.json:11`-`33`. The existing supervisor bridge has a concrete resolution order at `/Users/duckyoungkim/projects/aigentry-telepty/src/bridge/supervisor-launcher.js:52`-`76`.
  - Why: A global npm install will not necessarily have `telepty-cross-machine-bin` on PATH. The spec leaves the live migration path undefined.
  - Suggested fix: Add a bridge resolution contract matching `supervisor-launcher.js`: env override, repo-relative `target/{release,debug}`, PATH fallback, and a clear package/install story. Make this an acceptance criterion.

- **[MAJOR]** The stdout protocol is too fragile for a migration shim
  - Evidence: The draft directly parses stdout with `JSON.parse(res.stdout)` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:149`-`150`. The existing supervisor launcher distinguishes binary-not-found as a typed error at `/Users/duckyoungkim/projects/aigentry-telepty/src/bridge/supervisor-launcher.js:73`-`76`.
  - Why: A Rust panic, tracing line, clap usage error, or partial write will become a JS parse exception with poor operator diagnostics.
  - Suggested fix: Define the subprocess contract: stdout is exactly one JSON object on success; stderr is diagnostics only; non-zero exit maps to `{ success:false, code, error }`; wrapper checks `status`, `error`, and parse failures before returning.

- **[MAJOR]** Subprocess-per-inject adds avoidable latency on a hot path
  - Evidence: The draft uses synchronous process spawn in the shim at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:147`-`150`. The current direct cross-host inject path performs one HTTP POST at `/Users/duckyoungkim/projects/aigentry-telepty/cli.js:1780`-`1783`, and the cross-host delivery test waits for prompt output within 8 seconds at `/Users/duckyoungkim/projects/aigentry-telepty/test/cross-host-inject.test.js:60`-`75`.
  - Why: Fork/exec overhead and JSON process framing are not fatal for `connect-http`, but they are questionable for every injection, especially when the current path is a single HTTP request.
  - Suggested fix: Do not route hot injects through subprocess-per-call unless a latency regression test is added. Prefer direct HTTP until the Rust CLI exists, or run a persistent helper if Rust must own the path now.

- **[MAJOR]** Per-call subprocess state does not match the existing `activePeers` contract
  - Evidence: `activePeers` is process-local in `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:37`-`38`; `disconnect` only operates on that map at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:181`-`195`; `listActivePeers` reports the same process-local map at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:307`-`314`. The bridge draft creates a new subprocess for calls at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:147`-`150`.
  - Why: If the shim moves all behavior behind per-call Rust binaries, process-local peer state disappears unless every stateful operation is redefined around durable files.
  - Suggested fix: State explicitly which functions remain JS-stateful during migration and which move to durable Rust-backed state. Add tests for `connect`, `disconnect`, `peers`, and daemon `/api/peers`.

### Axis E — Acceptance criteria

- **[MAJOR]** HTTP auth/token parity is missing from the acceptance criteria and public API
  - Evidence: Current `connectHttp` stores `options.token` at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:366`-`408`, and HTTP list uses that token at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:440`-`442`. The daemon requires auth after `/api/health` unless the peer is allowlisted at `/Users/duckyoungkim/projects/aigentry-telepty/daemon.js:228`-`236`. The spec's parity list at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:63`-`68` does not mention token storage or authenticated list/inject.
  - Why: A Rust port can pass unauthenticated localhost tests and still fail real remote peers.
  - Suggested fix: Add acceptance for `connect-http --token`, token persistence in `peers.json`, authenticated `/api/meta`, `/api/sessions`, and queued inject replay with the saved token.

- **[MAJOR]** `peers.json` schema migration is not specified
  - Evidence: Legacy entries with no `transport` field default to SSH in `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:13`-`16`, and the SSH regression test requires that behavior at `/Users/duckyoungkim/projects/aigentry-telepty/test/cross-machine-ssh-routing.test.js:44`-`56`. New HTTP entries include `transport`, `host`, `port`, and `target` at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:397`-`405`. The spec only says peers are written to `~/.telepty/peers.json` at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:65`.
  - Why: Existing users have JS-era peer files. A Rust parser that requires `transport` or ignores legacy entries will break routing.
  - Suggested fix: Define `PeerEntry` as an untagged/backward-compatible schema where absent `transport` means SSH. Add fixtures for legacy SSH, HTTP with token, malformed peers, and unknown future fields.

- **[MAJOR]** The outbox has no disk cap or operator-visible queue policy
  - Evidence: The spec persists failed injects under `~/.telepty/outbox/<peer>/` and only drains/unlinks or moves dead letters at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:69`-`73`.
  - Why: A network partition can turn the outbox into unbounded disk growth. Dead-letter movement is not enough if the peer stays unreachable for days.
  - Suggested fix: Add a per-peer and global max queue size, oldest-first rejection or dead-letter policy, and a lightweight `outbox status`/structured log so operators can inspect stuck messages.

- **[MINOR]** Host parser parity needs explicit tests
  - Evidence: Current host parsing strips schemes and paths at `/Users/duckyoungkim/projects/aigentry-telepty/host-spec.js:15`-`16`, handles bracketed IPv6 at `/Users/duckyoungkim/projects/aigentry-telepty/host-spec.js:18`-`22`, and has no-double-port regression tests at `/Users/duckyoungkim/projects/aigentry-telepty/test/host-spec.test.js:25`-`35` and `/Users/duckyoungkim/projects/aigentry-telepty/test/host-spec.test.js:55`-`60`. The spec only names a generic `<sid>@<host>:<port>` parser at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:117`.
  - Why: The previous bug class was URL construction, not only `@` splitting.
  - Suggested fix: Add Rust tests mirroring `host-spec.test.js`, including URL stripping, IPv6 brackets, and embedded ports.

- **[MINOR]** The `list --peer` wording names a CLI surface that does not exist
  - Evidence: The spec says "`telepty list --peer <name>` equivalent" at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:66`. The current list command handles all-session discovery and `--json` at `/Users/duckyoungkim/projects/aigentry-telepty/cli.js:915`-`935`.
  - Why: This can send the implementer looking for or adding a non-existent flag.
  - Suggested fix: Rewrite to "list sessions discovered through a named HTTP peer entry, without adding a public `--peer` flag unless separately approved."

### Axis F — Constitution + ADR compliance

- **[CONFIRMED]** The dispatch stays inside telepty's mechanism boundary
  - Evidence: The ADR says telepty owns cross-host addressing at `docs/adr/2026-05-05-telepty-devkit-boundary.md:135` and cross-machine glue/peer registry at `docs/adr/2026-05-05-telepty-devkit-boundary.md:357`-`364`. The spec cites this boundary at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:222`-`225`.
  - Why: Cross-machine transport, peer registry, and outbox delivery are telepty primitives, not devkit scaffolding.
  - Suggested fix: Keep the boundary citation, but fix the implementation inconsistencies above.

- **[MINOR]** Constitution excerpts marked "verbatim" are paraphrases
  - Evidence: The spec labels Article 17 as verbatim at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:227`-`230`, Article 1 at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:232`-`235`, and Article 5 at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:237`-`240`. The source text is longer/different at `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:21`-`28`, `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:78`-`86`, and `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:220`-`227`.
  - Why: The meaning is mostly aligned, but "verbatim" is inaccurate and weakens auditability.
  - Suggested fix: Either paste exact source lines or label the current text as "summary/paraphrase."

- **[CONFIRMED]** The standalone crate requirement aligns with Constitution Article 9
  - Evidence: The spec requires `cargo build -p telepty-cross-machine` to succeed without supervisor-core at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:206`. Article 9 requires components to work independently at `/Users/duckyoungkim/projects/aigentry/docs/CONSTITUTION.md:125`-`132`.
  - Why: A standalone cross-machine crate is the right independence boundary.
  - Suggested fix: Keep this as a hard acceptance gate.

- **[CONFIRMED]** The Snyk gate is positioned realistically as a final security gate
  - Evidence: The spec requires Snyk in the test list at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:81`, step 15 at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:173`, and before final commit at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:242`-`251`.
  - Why: Running Snyk after the crate stabilizes is practical; requiring it after every commit would slow TDD without much extra safety.
  - Suggested fix: Keep final Snyk as required, with optional interim scans after dependency or unsafe-code changes.

### Axis G — Open questions

- **[CONFIRMED]** Deferring Tailscale auto-population to Phase 5b is the right cut
  - Evidence: The spec explicitly stubs `tailscale_status_peers()` and defers automatic `peers.json` population at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:74`-`76` and `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:93`. The current HTTP peer path is manual `connect-http` registration at `/Users/duckyoungkim/projects/aigentry-telepty/cross-machine.js:352`-`419`.
  - Why: Auto-discovery changes trust, naming, and persistence semantics. A stub is enough groundwork for Phase 5.
  - Suggested fix: Keep auto-population out, but define the Phase 5b trigger as noted below.

- **[MAJOR]** The Windows no-op language must not regress Windows-addressed SSH peers
  - Evidence: The spec says no Windows-specific code paths and "Unix-first with graceful no-op stubs for Windows" at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:90`, while the existing SSH regression fixture uses a Windows/Tailscale-style target `Administrator@win.tail.ts.net` at `/Users/duckyoungkim/projects/aigentry-telepty/test/cross-machine-ssh-routing.test.js:44`-`56`.
  - Why: "Windows supervisor is Phase 4" does not mean Phase 5 may break routing to Windows hosts through existing SSH peer records.
  - Suggested fix: Clarify that Windows-native supervisor code is out of scope, but existing SSH peer records targeting Windows hosts remain supported or remain on the JS path during the migration window.

- **[MINOR]** Phase 5b needs a concrete handoff trigger
  - Evidence: The spec defers Tailscale auto-population at `state/dispatch/2026-05-24-telepty-phase5-cross-machine-rust-port-dispatch.md:74`-`76` but does not define what data contract Phase 5 must leave behind.
  - Why: Without a schema note, Phase 5b may reinterpret `TailscalePeer` and force churn in `peers.json`.
  - Suggested fix: Add a short Phase 5b handoff section: `TailscalePeer { hostname, dns_name, tailscale_ip, os, online }`, no persistence in Phase 5, and a TODO acceptance fixture for `tailscale status --json`.

## Summary tables

### Finding count by severity

| Severity | Count |
|----------|-------|
| BLOCKER  | 3     |
| MAJOR    | 10    |
| MINOR    | 5     |
| NIT      | 0     |
| CONFIRMED | 7   |

### Recommended pre-dispatch changes (priority order)

1. Resolve the `cli.js` contradiction: either allow scoped CLI edits for direct `<id>@<host>:<port>` Rust routing or remove that acceptance from Phase 5.
2. Decide SSH migration explicitly: keep SSH paths in JS during the bridge window, or add Rust SSH parity and tests.
3. Specify binary resolution and npm/package distribution for `telepty-cross-machine-bin`.
4. Define the bridge subprocess protocol: exit codes, stdout JSON envelope, stderr diagnostics, parse failure behavior, and timeout handling.
5. Replace `Condvar` with `tokio::sync::Notify` and use telepty's fsync-backed atomic write pattern.
6. Fix outbox idempotency for multi-process callers; add process-concurrency tests.
7. Add acceptance for token-authenticated HTTP peers, legacy `peers.json` entries, host parser parity, queue caps, and dead-letter observability.
8. Re-estimate or split the dispatch after bridge/SSH/package scope is made explicit.
9. Change "verbatim" Constitution excerpts to exact quotes or label them as summaries.

## Reviewer notes

The strategic choice is good: cross-machine is the right first JS-to-Rust migration target, and a file-backed outbox belongs with the cross-machine mechanism layer. The draft fails because it treats the bridge as a small wrapper afterthought, but the bridge is the riskiest part of the migration. If orchestrator wants the smallest safe dispatch, keep JS SSH and direct CLI HTTP inject in place, land the Rust crate behind explicit subcommands for `connect-http`, peer listing, and outbox operations, then move CLI routing only after the binary packaging and subprocess protocol are proven.
