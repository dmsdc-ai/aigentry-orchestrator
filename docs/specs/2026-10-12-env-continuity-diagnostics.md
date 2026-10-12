# SPEC — ES-07 per-request stage diagnostics data model (task #2026101204)

- Status: CONTRACT SPEC — data model only (architect, 2026-10-12). No code, no UI implementation.
- Parent: task #2026101204; requirement `state/specs/2026-10-12-environment-sharing-release-requirements.md`
  acceptance criterion 7 (line 44); build-plan draft §3 ES-07 (lines 66–67).
- Owners (proposal): orchestrator + CLI (view), telesession (ledger fields it already owns).
- Depends on: ES-05 / telesession #2026101110 PR3 ledger; telepty #100, #102, #103/#104; ES-01
  (`devices.last_seen_at`, for `offline` only).
- ADR: `docs/adr/2026-10-12-env-continuity-context-and-workspace.md`.

**Reading convention (orchestrator guardrail 2026-10-12 13:59Z).** Part A = FINDINGS only. Part B =
PROPOSALS only; each rule is a **proposal requiring user review** unless tagged `[REQ]` (requirement
doc line), `[DRAFT]` (build-plan draft line) or `[EXISTING]` (already specified in a cited file).

# PART A — FINDINGS

## 0.1 Exists (measured 2026-10-12, telesession worktree @ `b7effec`, spec only — code not read)

All references are to `aigentry-telesession-wt-1110/docs/specs/2026-10-11-e2e-delivery-protocol.md`.

| Fact | Line |
|---|---|
| Ordered ledger stages `transport_accepted(1) → durable_received(2) → agent_consumed(3) → processing_completed(4) → origin_ack_received(5)`; terminal `rejected`; derived `unknown`, `expired` | 121 |
| Status view `status ∈ pending | completed | rejected | unknown | expired | not_tracked`, with `stages` (first-evidence time per stage, null = no evidence), `status_reasons`, `unproven`, `checkpoint` (origin agent read cursor), `outbox` | 109–117, 75 |
| Skipped lower stages stay null and are reported as `unknown` for that stage | 124–125 |
| `completed` requires `origin_ack_received` AND an origin checkpoint covering the first final reply | 142–147 |
| `rejected` only from an authenticated destination event | 151–154 |
| Timeout/deadline never yields `not_delivered`; `unknown` = deadline passed or outbox uncertain | 155–157 |
| `expired` = tracking ended while outcome open, "outcome unknown, no longer tracked"; a retired record already `completed`/`rejected` keeps that status (`RETIRED`) | 158–160 |
| Record lifecycle `active` (≤ deadline) / `past_deadline` (open outcome reads `unknown`, `DEADLINE_PASSED`) / `retired` (open outcome reads `expired`, `RETIRED`) | 211–215 |
| Intermediary hop ACK can only advance stages 1–2 (R1); marker strings are corroboration, not authentication (R3) | 47–52 |
| Telepty dependencies: #100 (remote sender not host-attributed → no remote destination stage applied), #103/#104 ("submitted" = queue receipt → maps only to `transport_accepted`), #102 (queue vs parked backlog diagnostics) | 313–319 |
| Diagnostics linkage rule: report separately daemon queue depth vs bridge parked backlog, heartbeat-ok vs data-path-ok, `lastActivity` vs `lastOutput`; missing evidence → `unknown` | 402–405 |
| `telesession_health` reports ledger state separately from request status | 196–198 |
| Topology in that environment: origin agent → MCP tunnel → telesession → local daemon → orchestrator session → further legs | 54–57 |

## 0.2 Searched for and not found

- No per-hop observation for the "access layer" or "PTY write" in the telesession spec: a search for
  `PTY` in it finds no match. Its telepty mappings cover only "submitted" = queue receipt →
  `transport_accepted` (line 318) and a consumption observation → `agent_consumed` (lines 327, 339).
- No field in the status view that carries per-hop evidence source or freshness (`stages` has only
  timestamps, line 75).
- No definition of an `offline` state in the ledger (status enum line 110 has none).
- No Kkoma (꼬마) or access-layer component in the repositories read; their observation sources are
  therefore unknown.

## 0.3 Not measured

telesession code (`src/relay/*.js`) and tests were not read or run; telepty daemon APIs and their
freshness — in particular whether telepty can observe a PTY write at all (telepty was not read, so "PTY
write is unobservable" is **not** a finding); real cross-host behaviour (Mac offline per requirement line 60); RC5/#107 state.

# PART B — PROPOSALS (each requires user review unless tagged)

## 1. Principles

- P1. `[REQ line 44]` Access health never implies request completion. A healthy host/daemon is
  reported in a separate `access_health` object with `implies_request_state: false`.
- P2. `[EXISTING line 142]` Only the telesession ledger decides `completed`. New proposal (needs
  review): diagnostics are a read-only, derived **view**; they never write ledger stages or change
  `status`.
- P3. `[REQ line 44]` Each stage carries time, evidence and freshness; missing evidence is `unknown`
  (`[EXISTING line 405]`), and "cannot be observed by design" is distinguished from "not yet observed".
- P4. Diagnostics are computed on read; they are not stored as authority. A cache, if any, is labelled
  with its `fetched_at`.
- P5. `[REQ line 12]` `[DRAFT line 9, 27]` Works from any terminal on the telepty daemon; no GUI typing,
  no cmux dependency; a copied log file or an SSH connection alone never claims completion. New proposal (needs
  review), applied here:
  diagnostics read only the telesession ledger/status API, telepty daemon APIs and the ES-01 registry
  (the `evidence.source` enum, §3); no hop is derived from a GUI, a cmux pane, screen scraping, a copied
  log file or the output of an SSH session. A hop whose only available evidence would be one of those is
  `unknown`.
- P6. `[REQ line 52]` A Linux-only fixture PASS of any DG row is not reported as a cross-platform or
  real-endpoint E2E PASS. A real-endpoint claim needs the daemon→PTY→agent→origin final-ACK evidence
  of DG-16, which is BLOCKED today.

## 2. Stage model

Hops (ordered, per request leg): `kkoma` → `access_layer` → `daemon` → `pty` → `agent` → `final_reply`.

| Hop | Meaning | Evidence sources (preferred first) | Ledger mapping `[EXISTING]` where applicable |
|---|---|---|---|
| `kkoma` | request created by the user's front agent at the origin | ledger record `created_ms`, `request_id`, `correlation_id` | record exists (lines 61–79) |
| `access_layer` | the request reached the route toward the destination host (tunnel / relay / account access) | outbox item — exists only for **relayed** items, and the relay runner is off by default (telesession lines 383, 399); route resolver result (`ROUTE_UNRESOLVED`/`ROUTE_AMBIGUOUS`, line 307). A direct send has no access-layer source → `unknown`, reason `NO_ACCESS_LAYER_SOURCE`. Outbox mapping: `queued`/`intent` → no evidence yet (reasons `OUTBOX_QUEUED`/`OUTBOX_INTENT`); `sent` → `observed`, basis `queue_receipt`, `authenticated:false` (hop evidence only, line 373); `failed` → `unknown`, `OUTBOX_FAILED`; `uncertain` → `unknown`, `OUTBOX_UNCERTAIN`; a quarantine marker adds `OUTBOX_QUARANTINED:<reason>` (lines 222–232) | outbox (§10 of the telesession spec) |
| `daemon` | destination telepty daemon accepted / durably stored | `transport_accepted`, `durable_received` | stages 1–2 |
| `pty` | bytes written into the destination session's PTY | no evidence source is defined (none in the telesession spec, §0.2; telepty not read, §0.3) → `unknown` with reason `PTY_EVIDENCE_UNAVAILABLE` until a telepty source is identified and mapped | none |
| `agent` | destination agent consumed the request | `agent_consumed` (authenticated destination event) | stage 3 |
| `final_reply` | authenticated final ACK recorded at origin and read by the origin agent | `processing_completed` + `origin_ack_received` + checkpoint cover | stages 4–5, `completed` |

## 3. Observation record

```
StageObservation = {
  hop: "kkoma"|"access_layer"|"daemon"|"pty"|"agent"|"final_reply",
  state: "observed"|"completed"|"pending"|"unknown"|"offline"|"rejected"|"expired",
  observed_at: ISO | null,            // when the evidence says the hop happened
  evidence: { source: "telesession_ledger"|"telesession_outbox"|"telepty_daemon"|"telepty_audit"
                      |"registry_device"|"none",
              ref: string|null,         // e.g. ledger stage name, outbox item key, audit row id — no tokens
              authenticated: bool,      // adapter attestation (telesession R3), false for corroboration
              basis: string },          // e.g. "verified_sender_sid+epoch", "queue_receipt"
  freshness: { fetched_at: ISO, age_ms: int, max_age_ms: int, stale: bool, cached: bool },
  reasons: string[]                    // e.g. PTY_EVIDENCE_UNAVAILABLE, REMOTE_PROVENANCE_UNAVAILABLE, DEADLINE_PASSED
}

RequestDiagnostics = {
  schema: "aigentry-request-diagnostics", schema_version: 1,
  request: { correlation_id, request_id, nonce },
  ledger_status: <telesession status, copied verbatim>,
  stages: StageObservation[6],
  access_health: { host_key, daemon: "up"|"down"|"unknown", heartbeat_at, data_path: "ok"|"unknown"|"failed",
                   fetched_at, implies_request_state: false },
  generated_at: ISO
}
```

### 3.1 State semantics
| State | May be set when | Never set when |
|---|---|---|
| `observed` | evidence exists for this hop — whether or not the request is finished (`completed`/`rejected`/`expired`); a finished request never fills a hop that has no evidence | from a later hop's evidence (that is `unknown`, below) |
| `completed` | only on `final_reply`, and only when `ledger_status == "completed"` | anywhere else; from health; from a marker string |
| `pending` | ledger `lifecycle == "active"` (within `deadline_ms`, ledger lines 211–213) and `ledger_status == "pending"`, no evidence for this hop, **no later hop has evidence**, hop observable | deadline passed; request finished; a later hop has evidence |
| `unknown` | no evidence and any of: a later hop has evidence (`SKIPPED_STAGE_NO_EVIDENCE` — `[EXISTING line 124-125]` skipped lower stages stay null and read `unknown`); deadline passed with the outcome open (`DEADLINE_PASSED` — `[EXISTING line 155-157, 214]`, ledger lifecycle `past_deadline`); the request finished without evidence for this hop (`NO_HOP_EVIDENCE`); hop unobservable; evidence source unreachable; evidence unauthenticated | — (default) |
| `offline` | the evidence source for the **destination host** reports it unreachable/down with `fetched_at` within `max_age_ms` (e.g. registry device last-seen — an **ES-01 dependency**: `devices.last_seen_at` is proposed in the ES-01 spec §3.1 and does not exist yet; daemon health) | the source itself is unreachable (that is `unknown`); used for a request outcome |
| `rejected` | `[EXISTING line 151]` ledger `terminal.state == "rejected"` (authenticated). The ledger `terminal` is `{state, at, reason}` with no hop (line 76); the hop is derived from the ledger rule that `rejected` is a destination-only stage (lines 165–166): shown on `agent` (the destination endpoint) and on `final_reply` (the outcome), with `terminal.reason` as the reason; other hops are evaluated normally | from an unauthenticated message, timeout or local error; on `kkoma`/`access_layer`/`daemon`/`pty` |
| `expired` | exactly when `ledger_status == "expired"` (`[EXISTING line 158-160, 215]`: record retired while the outcome was open, reason `RETIRED`) — on every hop without evidence; hops with evidence stay `observed` | to mean "not delivered"; from a transport/nonce TTL or outbox state (a passed deadline with an open outcome is `unknown`/`DEADLINE_PASSED`); for a retired record that was already `completed`/`rejected` (it keeps that status, line 160) |

Evaluation order per hop (first match wins): `rejected` (on `agent`/`final_reply` only) → `completed` → `observed` → `expired` →
`unknown` (each condition above) → `offline` → `pending`. Hence a hop can never read `expired` while
`ledger_status` is `unknown`, and never `pending` once a later hop has evidence or the request finished.

`offline` describes the host at observation time; it does not change the request's `ledger_status`
(a request to an offline host stays `pending` → `unknown` per the ledger rules, lines 155–157).

### 3.2 Freshness
Default `max_age_ms`: ledger 0 (read directly), daemon/health 30 000, registry device last-seen 120 000
(ES-01 dependency; until it exists `offline` can come only from daemon health).
`stale: true` downgrades `offline` and `observed` evidence from non-ledger sources to `unknown` with
reason `EVIDENCE_STALE`. Values are proposals; tuned during ES-09.

## 4. Attachment to telesession `request_status`

- Proposed: an **optional** `diagnostics: RequestDiagnostics` member added to the
  `telesession_request_status` result only when the caller passes `diagnostics: true`; the default
  output is unchanged (backward compatible with lines 109–117).
- `diagnostics.ledger_status` must equal the top-level `status` of the same response; `status` and
  `status_reasons` are computed exactly as today and before diagnostics.
- Non-ledger sources (telepty daemon, registry) are read by the orchestrator/CLI layer, not by
  telesession, to keep telesession's trust boundary (line 280) unchanged; the CLI merges them into the
  view. Ownership of the merge: ES-07; ownership of the ledger: ES-05/telesession (no change to its
  stages).
- Multi-leg: diagnostics are per leg (per nonce); the leg-n view is linked only when the leg-1
  destination carried the `correlation_id` (`[EXISTING line 423-424]`: origin does not yet link leg-n
  nonces).

## 5. User-facing rendering (contract for the UI, not an implementation)

One line per hop: `hop  state  observed_at  (source, authenticated?, age)  reasons`. The request line
shows `ledger_status` first. Access health is rendered in a separate block titled "Connection
(does not mean your request finished)". Words "delivered", "done" or "completed" are used only for
`completed`.

## 6. Acceptance criteria → test matrix

Columns: **Measures** = what a PASS of the row proves; **Does not measure** = what it does not prove;
**Runnable now** = `Linux fixture` (runs on the Linux host alone, with the local/stub dependencies named in
the row, once the implementation exists) or `BLOCKED`; **Blocked on** = the missing dependency. A BLOCKED
row is never reported as PASS (not as "skipped = pass", not by a Linux substitute). A Linux-fixture PASS
proves only its Measures column and is never a cross-platform or real-endpoint PASS (`[REQ line 52]`). No
row has been run; no implementation exists.

| ID | Criterion | Setup | Expected | Measures | Does not measure | Runnable now | Blocked on |
|---|---|---|---|---|---|---|---|
| DG-01 | `[REQ line 44]` Health ≠ completion | daemon up, heartbeat fresh, request has only `transport_accepted` | `access_health.daemon: up`; `final_reply.state` ≠ `completed`; `ledger_status` `pending` | health and request state kept apart | a real daemon's health signals | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-02 | PTY evidence unavailable | (a) any request today; (b) once a telepty PTY-write source is identified and mapped | (a) `pty.state: unknown`, reason `PTY_EVIDENCE_UNAVAILABLE`, never `observed`; (b) `observed` only from that source, with `authenticated` per its attestation | (a) the PTY hop never claims evidence it lacks | (a) whether a PTY write happened | (a) Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357); (b) BLOCKED | (b) a telepty PTY-write evidence source (none identified; telepty not read) |
| DG-03 | Offline vs unknown | destination host down with fresh registry last-seen; separately, registry unreachable | first: `offline` on `daemon`; second: `unknown` with `EVIDENCE_SOURCE_UNREACHABLE` | `offline` vs `unknown` separation | real host outages | registry-unreachable and daemon-health variants: Linux fixture; registry last-seen variant: BLOCKED | ES-01 `devices.last_seen_at` (registry device API) |
| DG-04 | Rejected only authenticated | unauthenticated refusal text vs authenticated destination `rejected` event | first does not set `rejected`; second sets `rejected` on `agent` and `final_reply` (derived from the destination-only rule, §3.1) with `terminal.reason`; earlier hops keep their own evidence | `rejected` only from an authenticated destination event; hop attribution | remote-host authentication | local destination: Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357); remote destination: BLOCKED | telepty #100 (remote sender provenance) |
| DG-05 | Expired = ledger expired only | (a) record retired with open outcome; (b) record `past_deadline` (deadline passed, not retired) with open outcome; (c) transport nonce TTL ended (`TRANSPORT_NONCE_EXPIRED`) while the ledger is `active`/`past_deadline` | (a) `ledger_status: expired`, hops without evidence `expired` (`RETIRED`), hops with evidence `observed`; (b) `ledger_status: unknown`, hops without evidence `unknown` with `DEADLINE_PASSED`, no hop `expired`; (c) no hop `expired`; UI never says "not delivered" in any case | `expired` only for ledger-retired open outcomes; `DEADLINE_PASSED` → `unknown` | real TTL timing | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) (fast clock) | — |
| DG-05b | Retired after finish | record `completed` (or `rejected`), then retired | `ledger_status` stays `completed`/`rejected` with reason `RETIRED`; no hop `expired` | finished outcome survives retirement | — | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-06 | Completed only via ledger | final reply recorded but not read by origin agent | `final_reply.state: observed`, reason `AWAITING_ORIGIN_AGENT_READ`; after checkpoint covers it → `completed` | `completed` only after the origin checkpoint covers the final ACK | a real origin agent's read behaviour | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-07 | Stale evidence | daemon health older than `max_age_ms` | downgraded to `unknown`, `EVIDENCE_STALE` | staleness downgrade | real source latencies (defaults are proposals) | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-08 | Backward compatibility | `request_status` without `diagnostics:true` | output identical to the current view | default `request_status` output unchanged | the telesession-side implementation of §4 (not yet written) | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-09 | Origin restart | restart telesession between stages | diagnostics recomputed from the ledger; no stage lost or advanced by the restart | recompute from the ledger after restart | a crash on another host | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-10 | No secrets/ids leak | inspect the diagnostics JSON | no tokens, no prompt text, host shown as a key, not an address | no tokens, prompt text or addresses in the output | logs of the components it reads | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-11 | `[REQ line 12]` No GUI / no cmux | cmux not installed, no GUI session; request sent and diagnosed through telesession/telepty APIs only; a log file copied from the destination is placed next to the CLI | every `evidence.source` is in the §3 enum; the copied log changes no hop; same states as with the log absent | no GUI/cmux/log-copy input changes any hop | real remote hosts | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | cross-host variant: telepty #100 |
| DG-12 | Skipped stage | within the deadline, `agent_consumed` has evidence while `transport_accepted`/`durable_received` are null | `daemon.state: unknown`, reason `SKIPPED_STAGE_NO_EVIDENCE` (not `pending`); `agent.state: observed` | skipped stages read `unknown`, not `pending` | — | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-13 | Finished request, non-final hops | (a) `completed` request whose `daemon` hop has evidence and `access_layer` has none; (b) `rejected` request with `daemon` evidence | (a) `daemon: observed`, `access_layer: unknown` (`NO_HOP_EVIDENCE` / `SKIPPED_STAGE_NO_EVIDENCE`), `final_reply: completed`; (b) `daemon: observed`, no hop `pending` | finished-request rule for non-final hops | — | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-14 | Late ACK | (a) `completed` request, then a newer final reply arrives; (b) a final reply verified after the transport TTL (`late_after_ttl`) | (a) `final_reply` stays `completed` with reason `NEWER_FINAL_ACK_UNREAD` until the checkpoint covers it (ledger lines 145–147); (b) reason `LATE_AFTER_TTL`, `completed` only once the origin checkpoint covers it (line 279) | late-ACK reasons and `completed` stability | real late-reply timing | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-15 | Access layer evidence | (a) direct send; (b) relayed item `sent`; (c) relayed item `uncertain`; (d) quarantined item | (a) `access_layer: unknown`, `NO_ACCESS_LAYER_SOURCE`; (b) `observed`, `authenticated:false`; (c) `unknown`, `OUTBOX_UNCERTAIN`; (d) reason `OUTBOX_QUARANTINED:<reason>` added | access-layer mapping incl. direct sends | a live relay runner (off by default; activation is a separate approval, line 399) | Linux fixture (ledger fixture + fake adapters, telesession `test/helpers/fake-receipts.js`, spec line 357) | — |
| DG-16 | `[REQ line 52]` Real endpoint E2E | origin on the Linux host → real telepty daemon on another host → PTY → destination agent → authenticated final ACK recorded at the origin and read by the origin agent | `ledger_status: completed`; every hop shows evidence from a real source with `authenticated` as attested; recorded as the real-endpoint evidence of requirement line 52 | the only row that can support a real-endpoint claim: daemon→PTY→agent→origin final-ACK evidence across real hosts | cross-platform behaviour beyond the hosts used | BLOCKED | telepty #100, #103/#104, RC5/#107 (red), a PTY-write evidence source, a second real host (Mac offline, requirement line 60) |
