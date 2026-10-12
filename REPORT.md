REPORT: oc-1204-idq task #2026101204 — CONTRACT SPEC — DONE

Contract specs for ES-01 identity/device and ES-03 shared queue (with the ES-08 intake
linkage) are written, with the ADR. This is a specification deliverable only: no code,
no tests, no queue edit, no migration, no credential, no network use. It does not claim
completion of #2026101204 or any child.

commits:
- see `git log task-1204-env-continuity-idq` (single docs commit on top of 71cc2da; hash is in the REPORT inject)

files:
- docs/specs/2026-10-12-env-continuity-identity.md (ES-01)
- docs/specs/2026-10-12-env-continuity-shared-queue.md (ES-03 + ES-08 §12)
- docs/adr/2026-10-12-env-continuity-identity-and-queue.md (ADR)
- REPORT.md

guardrail applied (orchestrator follow-up 2026-10-12 13:59Z):
- ES-03 §3 is now Findings → Proposals (P-A server per-queue counter, P-B Mac ledger +
  server mirror, P-C partitioned ranges, each with concurrent-issuance, offline,
  alias/migration analysis) → "DECISION REQUIRED BY USER" (D-Q-1). No issuance scheme
  adopted, no migration before the Mac ledger/allocator and mapping are reviewed.
  Dependent text (schema, projection, offline create, ES-01 enumeration note, matrix
  Q-14/Q-15) reworded so that no rule reads as adopted.
- Finding (a) re-measured: no allocator rule in docs/rules.md, AGENTS.md,
  .agents/skills/orchestrate-turn/SKILL.md, bin/tq-*.sh (read and sort only; the one write
  is active_focus at tq-focus.sh:19), release/PROJECTION.md. Finding (b): Mac ledger
  unreadable (offline).

grounded_in:
- aigentry-registry@ac221cd
  - src/aigentry/api/v1/auth.py:43-106 — JWT-cookie path substitutes any active tenant API key (user identity lost, :71-82); Redis failure falls through (:83-84).
  - src/aigentry/api/v1/oauth.py:28-246 — GitHub web flow; cookies only (:94-113); refresh reads cookie only (:166); rotation without reuse detection (:186-191); state values logged (:59-72).
  - src/aigentry/services/auth/oauth_service.py:29,84-169 — scope read:user user:email; one tenant per user (:102-109); admin via ADMIN_GITHUB_IDS (:111-120); JWT claims and lifetimes.
  - services/auth/revocation_service.py — Redis-only jti revocation with TTL.
  - services/auth/session_service.py:11 — 24 h sessions tied to API key.
  - services/auth/api_key_service.py:20,55-87 — aig_ keys, sha256 hash.
  - models/user.py, api_key.py, user_session.py, tenant.py, user_role.py — schemas (api_keys has no user_id; github_id Integer).
  - alembic/versions/20260309_000001…, 20260214_000002… — users/auth tables; single alembic head 20260319_000002 (computed).
  - api/v1/tenants.py:34-70 — unauthenticated first-tenant bootstrap.
  - db/session.py:10-20 — request-scoped commit/rollback.
  - config.py:16-18,91-93,107-122 — Postgres asyncpg, rate limits, JWT settings (60 min / 7 d).
  - main.py:89-108 — slowapi limiter.
  - pyproject.toml:36-37 — cryptography, PyJWT present.
  - api/router.py:85,100 — auth/oauth mount points.
- aigentry-devkit@604f2b5
  - package.json:18-21 — only `aigentry-devkit` binaries.
  - bin/aigentry-devkit.js:24-60,754-830 — command table, no login/device.
  - install.sh:24-26,242-246,261-269,666-725 — plaintext API key in env.sh and install-state.json; registry modes cloud/self_hosted/skip; bootstrap call.
  - install.ps1:17-19,160-184 — same on Windows, no ACL step.
- aigentry-telesession@90d88aa (main; PR #3 commit b7effec not present, not read)
  - API-CONTRACT-TELESESSION.md:141-147,172,180-182 — request_id dedupe semantics, id alphabet, "not exactly-once".
  - src/transports/telepty.js:989-993 — REQUEST_IN_FLIGHT / REQUEST_ID_CONFLICT.
  - src/store.js:63,316-330 — request states; atomic write pattern.
- orchestrator (this clone @71cc2da, plus private state from the main checkout, read-only)
  - src/dispatch/cli.ts:671-892 — task gate modes/statuses/rc codes, ambiguity rc 5, auto-ledger and atomic write.
  - release/tasks.json, release/PROJECTION.md:20-75, scripts/release-admission.mjs:17-27,228-242 — projection = positive safe integer id + slug; hand-authored; private queue is the authority.
  - src/control/contracts.ts:18-24 — task.create is a pending (refused) operation.
  - docs/rules.md Rule 34 (568-597), 45 (837-849), 47 (864-882), 50 (907-918).
  - tooling/instructions/CONSTITUTION.md 제1,4,6,14,15,17조.
  - state/task-queue.json (main checkout) — 37 rows, all integer date-form ids; status counts; link-field shapes (free-text dependencies); #2026101204 canonical_id BLOCKED, approval/not_approved, children 2026101206–14.
  - state/specs/2026-10-12-environment-sharing-release-requirements.md, state/draft/2026-10-12-environment-sharing-build-plan-proposal.md — scope, acceptance criteria, test matrix.

decisions_needed:
- D-ID-1 token lifetimes — privacy/permission — rec: access 15 min; refresh idle 30 d / absolute 90 d; rotation with reuse → revoke.
- D-ID-2 device secret storage — privacy/permission — rec: macOS Keychain (`security`), Linux 0600 file ~/.config/aigentry/device/, Windows DPAPI file; never env/state files/logs.
- D-ID-3 enable device credential + endpoints on a deployed registry — permission expansion/production deploy — rec: ship disabled, enable after ES-09 isolation PASS.
- D-ID-4 devices → registry HTTPS traffic — network change/personal-data transfer — rec: only to the install-chosen registry URL; no new relay.
- D-Q-1 canonical ID issuance (P-A/P-B/P-C) and whether to migrate — operational data change — NO default adopted (guardrail); prerequisites: Mac ledger read + sha256, mapping dry-run with collision list, issuance freeze.
- D-Q-2 registry Postgres as authoritative store (opt-in) — operational data/personal-data transfer — rec: yes, opt-in, self-hostable, local-only unchanged.
- D-Q-3 execute migration M3/M5 — operational data change — rec: only after D-Q-1 and the user's review of mapping.json; nothing deleted.
- D-Q-4 server retention of notes/events — personal data — rec: queue lifetime + export.
- D-Q-5 default reassign_policy (autonomous Linux takeover) — permission — rec: auto for tasks Linux is configured to serve, else manual.

not_measured:
- Mac queue/ledger (offline): contents, max id, issuance practice, duplicates.
- Registry deployment state, version, secrets/Redis/Postgres config, TLS; GitHub OAuth configured or not.
- Registry frontend (settings/approval page) — not read.
- telesession PR #3 at b7effec — not in the readable checkout.
- macOS/Windows behaviour of any key store; Postgres isolation level in deployments (spec assumes the default READ COMMITTED).
- Whether aigentry-ssot already registers any devices/queues contract.

estimate_inputs:
- Identity: the reusable base is larger than assumed, but the new surface (2 tables, about 7 endpoints, a frontend approval page, bearer dependency, refresh family, a 3-OS key store, 4 CLI commands) and the G2 fix in a shared auth dependency push it to the upper half of 3–6.
- Queue: about 7 tables, about 11 ops, cache/sync client, gate changes (resolve + lease + rc 6 + event ledger), reconcile. Upper half of 5–10 under P-A/P-B (Mac read + mapper + dry-run); lower half under P-C.
- ES-08 contract: small.
- ES-09: the per-OS rows cannot close on Linux only. Mac offline and no Windows runner measured.
- 제15조 SSOT multi-component approval adds latency that the placeholder does not include.

snyk: NOT_APPLICABLE_DOCS

blockers:
- none for this deliverable.
- For follow-on work: D-Q-1 (needs the Mac online), D-ID-3/4 approvals, SSOT registration.
- Report inject: per dispatch the telepty inject is expected to fail in the sandbox. This file is the evidence fallback, not proof of delivery (Rule 49 §5).

remaining issues noted, not fixed (Rule 29): plaintext registry API key in devkit env/state files; OAuth state logged; users.github_id 32-bit Integer.
