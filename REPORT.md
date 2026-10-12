REPORT: oc-1204-idq2 task #2026101204 — CONTRACT SPEC FIX 1 (idq) — DONE

branch: task-1204-env-continuity-idq (base e2269f3, new commits only, not pushed)
files: docs/specs/2026-10-12-env-continuity-identity.md (ES-01), docs/specs/2026-10-12-env-continuity-shared-queue.md (ES-03 + ES-08 §12), docs/adr/2026-10-12-env-continuity-identity-and-queue.md, REPORT.md

commits:
- d1d6440 B1 slowapi wiring restated; per-route /devices limits as new work; fail closed
- 92a1f8b B2–B4 inference vs measurement; neutral §3.4; per-proposal 제4조; scheme-neutral §11
- e528072 B5–B7 gate contract vs cli.ts; same-device re-claim; lease keeper
- d4cacfb B8 refresh check order and retry tolerance
- 82afaf4 B9 durable device check on every ES-0x request
- e3568a4 B10 stdin-only secret transport
- e267cfd B12 ES-08 retry contract
- f0cfe8a B13 Rule 47 rows (local amend of my own unpushed commit; a script failure had left the ADR half out)
- 8b7b22b B11 per-row testability matrices
- e4a75cc non-blocking + grounding corrections + ES-01 §8.1 interface for ES-02/ES-04
- f3643e8 escape two table pipes
- 9c484f8 coordination C1–C5 (ES-01 §3.1, §8, §8.1, ID-21)

resolved:
- B1: ES-01 §1.4 now reports the wiring as measured: a Limiter is built (main.py:90-95) but no SlowAPIMiddleware is registered (main.py:191-203), so default limits do not run. The only decorator is repositories.py:80, on its own Limiter (:26). The registry rate-limiter issue is cited. §7.4 proposes per-route decorators on /devices/* and does not turn on the global middleware. If the limiter store (Redis) is down, authorize/approve/deny/token fail closed with 503. Test rows ID-12 and ID-13. ADR §7 prices this as new work.
- B2: ES-03 §3.1 "Exists (measured)" now says "observed …; issuer not measured". The parent-row quote is marked as a record, not a measurement. The "presumably" and "no coordination" text moved into a labelled "Inference (not measured)" list.
- B3: ES-03 §3.4 "architect's input" was replaced by a summary of the §3.2 table with no ranking. P-C is stated as having the best issuance availability. The P-B cross-host path and the 제4조 cost are listed as consequences of the options, with no default.
- B4: ADR §4 gives a 제4조 verdict per proposal (CONSTITUTION.md:68-75). P-A complies. P-B is two authorities and is admissible only with an SSOT allocator contract plus a declared mirror. P-C is admissible only with exactly one client-side counter (the lease keeper). ES-03 §11 local-only mode is now scheme-neutral. The ADR D-Q-1 row no longer points to an "architect's input".
- B5: ES-03 §3.6 now separates internal rc (cli.ts:764-788) from process exits (taskGateReject: exit 4 in hard at :731, proceed in warn/off at :725-729; ambiguous id exits 5 in every mode at :774).
  - New finding: exit 6 is already taken by waitForReady "never registered" (:1123-1126, exited at :1335). The lease refusal is therefore exit 11 TASK_LEASE_HELD, and "lease unavailable" is exit 12. Both are mode-independent; warn/off do not bypass them. In account mode the escape hatch is the audited --no-task.
  - The gate at :1260 stays read-only. The claim is a separate lease step after the dedup/retry checks (:1285-1308) and before spawn (:1310-1312).
  - Exits before transport detach the sid and release the lease. Exits 8, 7, 5-after-transport and 3-after-a-failed-inject (:1388-1395) keep the attachment. kill -9 falls back to TTL expiry.
  - A dispatch promotes only pending|queued → delegated, as today's ledger does (:855). Q-15 was rewritten to match.
- B6: §4.2 SQL now allows `OR lease_device_id = :d`. A live same-device claim does not bump the token, extends the TTL and returns new_lease=false. An expired or absent lease bumps. Q-18 covers the second dispatch from the same device; Q-7 and Q-9 were adjusted.
- B7: new ES-03 §5.1 names the devkit lease keeper as the heartbeat owner: a user-level, on-demand, single-instance process that is the only reader of the ES-01 key store. Callers reach it over a 0600 UDS with peer-uid check, or an ACL'd named pipe on Windows; tokens never cross that endpoint. §5.1 gives its lifecycle and failure modes. Q-7 now kills this process. The ADR §3 rejected row is narrowed to network daemons/relays. Running the keeper is decision D-Q-9.
- B8: ES-01 §5 defines the check order: device lookup, then the Ed25519 proof, then the hash.
  - Current hash → rotate.
  - refresh_prev_hash → treated as a lost-response retry: re-rotate, never revoke, at any age.
  - Any older hash with a valid proof → revoke.
  - No valid proof → invalid_grant with no state change.
  - New columns refresh_prev_hash and refresh_rotated_at; new rows ID-14 and ID-15.
  - Pattern cited: RFC 9700 §4.14.2 and RFC 6749 §10.4, from memory; not re-read (no network).
- B9: ES-01 §7.1 and §7.2 now run a durable device check (`FOR SHARE`, against the revoke's `FOR UPDATE`) on every ES-0x request, reads included, with no Redis dependency. §11 is consistent with this. Brain-Git data is reader-verified (ES-02 R7). New row ID-16; Q-5 now covers sync reads.
- B10: §6 requires stdin-only secret transport: macOS `security -i` with the command on stdin, PowerShell `-Command -` with `[Console]::In`, Linux `secret-tool` reading stdin. No argv, env or temp files. The macOS default is explicitly conditional on ES-09 verifying the stdin path; if it cannot, D-ID-2 must be re-decided. The macOS fallback is now an explicit `--keystore file`. ID-10 now covers argv and env; D-ID-2 rows updated.
- B11: ES-01 §15.1 and ES-03 §13.1 add per-row "Measures / Does not measure / Env (Linux-only counts?) / Blocked on".
  - F1/H2/H3/OS3 are defined. Linux-only results never close H2, H3 or OS3 rows.
  - BLOCKED rows: ID-11, Q-17 (Mac offline, no Windows runner), Q-14, Q-22 (D-Q-1). Rows needing the Mac are marked "Mac offline".
  - New rows: ID-17 (admin does not cross users), ID-18 (X-API-Key refused), ID-19 (approval CSRF), Q-20 (untrusted content, issue text grants nothing), Q-21 (receipt states and atomicity), Q-22 (offline create), Q-23 (DEPENDENCIES_OPEN / VERSION_CONFLICT / EVIDENCE_REQUIRED).
  - Redis-down behaviour: ID-13 and ID-16. ES-08 retry: Q-19.
- B12: ES-03 §12.2 retry contract:
  - Only the adapter retries, from a local durable outbox.
  - Every attempt uses the same intake:<key>, delivery_ref and hash.
  - Retryable and never-retried sets are defined.
  - At most 8 attempts, full-jitter backoff (base 30 s, ×2, cap 1 h).
  - Terminal states rejected and retry_exhausted are visible in ES-07. Manual retry reuses the key.
  - Row Q-19.
- B13: new rows:
  - D-Q-6: OS hosts/runners (cost).
  - D-Q-7: hosted Postgres storage (cost / personal data).
  - D-Q-8: ES-08 blobs and receipts retention (personal data, third-party authors).
  - D-ID-5: revoked/expired device rows and authorizations retention (personal data).
  - D-Q-9: lease keeper (operational change).
  - Each has a recommended default, in the specs and in ADR §5.
  - The P-B network path is folded into the D-Q-1 category with no default.

non_blocking_applied:
- N1: the four line cites are corrected (api_key.py:21-31, user_session.py:21-25, session_service.py:13, API-CONTRACT:173).
- N2: two devkit binaries (package.json:19-20); the build plan's `aigentry login` is recorded as renamed to `aigentry-devkit login`.
- N3: samesite lax at login vs strict on /refresh (oauth.py:194-211). CORS allow_headers is noted (main.py:194-200).
- N4: G2 is closed only for ES-0x endpoints. The ADR §7 pricing is corrected and the general fix is left to the registry issue.
- N5: FOR SHARE vs FOR UPDATE (done with B9).
- N6: explicit --keystore file on macOS (done with B10).
- N7: tq-focus.sh:18-20 is named as a second writer, with its non-atomic cross-filesystem mv. active_focus and tracks are local-only cache fields. The atomicity fix is mentioned only.
- N8: the ADR says M1–M5 is needed under every option, and P-C only avoids renumbering. Lease keeper and outbox work are added to the estimate inputs.
- N9: the tasks.progress/progress_at columns hold the latest progress.
- N10: ID-5 and ID-6 are labelled supplementary.
- N11: ES-03 §2.3 is now conditional on D-Q-2.
- N12: D-Q-5 `auto` covers the claim only. Worker start is the AC5 approval (§6 and D-Q-5 rows).
- N13: sign-up = first GitHub login (oauth_service.py:84-136), in §4 and ID-2.
- N14: the approval page shows request time and network prefix (new request_net_prefix column). Active devices are capped at 20 (proposal, under D-ID-1). Row ID-20.
- N15: install-state.json with no chmod (install.sh:255) is added to the observed-not-fixed list.
- Grounding WRONG/NOT FOUND #12, #14, #15, #21, #24 and the #29 sub-cite were all re-measured and corrected.
- Sibling interface: ES-01 §8.1 provides what ES-02 §5.5 R1–R7 ask for:
  - signed per-device age_recipient (new columns plus PUT /devices/me/age-recipient);
  - an authenticated keyed device list including revoked devices and revoked_at (GET /devices?include=keys&all=true);
  - revoked_at set once and never re-bound;
  - registry-as-key-directory trust model, with endorsement left to ES-02 D-9;
  - github_id in /devices/me for the brain-repo binding;
  - the §7.2/§7.3 rows for brain-Git data reworded (R7);
  - row ID-21.
  The ES-02/ES-04 files were not edited.

declined: none.
- Partly deferred: N3's CORS change is conditional ("add it if the approval page is served cross-origin"). Where the page is served was not measured (the frontend was not read).

new_decisions: D-ID-5, D-Q-6, D-Q-7, D-Q-8, D-Q-9 (each with a recommended default). D-Q-1 now also carries "network change if P-B" (no default). The active-device cap of 20 is folded into D-ID-1.

grounded_in (new, read this cycle):
- registry @ac221cd:
  - main.py:90-95, :93, :107-108, :191-203, :194-200
  - config.py:23, :91-93
  - api/v1/repositories.py:7-8, :26, :80
  - api/v1/oauth.py:160-211 (/refresh: strict, no domain)
  - models/api_key.py:21-31; models/user_session.py:21-25
  - services/auth/session_service.py:13
  - services/auth/oauth_service.py:84-136
- devkit @604f2b5: package.json:19-20; install.sh:250-255 (writeFileSync, no chmod).
- telesession: API-CONTRACT-TELESESSION.md:173.
- orchestrator @71cc2da: src/dispatch/cli.ts
  - gate: :671-892, :725-731, :764-788, :774, :790-828, :855
  - exit-6 owner: :1123-1141, :1335
  - other exits: :1338, :1355, :1362, :1366-1368, :1388-1395, :1402-1404, :1413-1415, :1418-1420, :1424
  - sid derivation and dedup: :1260-1308
- orchestrator other files: bin/tq-focus.sh:18-20; tooling/instructions/CONSTITUTION.md:68-75; requirements §상세 수용 기준 AC1/3/5/8 and §검증 매트릭스; build plan line 84 ("OS runner 확보").
- sibling: ES-02 spec §5.1–§5.5 (ctxws clone @dbdf2ea), read-only.

not_measured:
- Runtime: nothing was executed, including slowapi without middleware, READ COMMITTED behaviour of FOR SHARE/FOR UPDATE, `security -i` stdin handling on macOS, PowerShell stdin/DPAPI on Windows, secret-tool, and SO_PEERCRED/getpeereid and named-pipe ACLs.
- Whether confined-worker sandbox profiles exclude the device directory (ES-09 item).
- RFC 9700 / RFC 6749 sections cited from knowledge; not re-read (no network).
- Not read: the Mac queue, the registry deployment, the frontend (where the approval page would be served), Postgres config, and aigentry-ssot.
- Whether a second or third real host is available for the H2/H3 rows.

coordination (orchestrator follow-up 14:39Z, ES-02 §5.5 R1–R7, sibling clone @623b8f6, read-only):
- The round-2 review read ES-01 @82afaf4. §8.1 and the R2/R3 fields were added later, in e4a75cc, and refined in 9c484f8.
- C1 (R2): ES-01 §3.1 has `age_recipient`, `age_recipient_sig` and `age_recipient_set_at`. They are registered at `/devices/authorize` (§3.2) or rotated by `PUT /devices/me/age-recipient` (§8).
  - Fixed in 9c484f8: the signature covered `device_id`, which does not exist yet when the device signs at authorize time. It now signs over `hex(public_key)`, which never changes for a row.
- C2 (R3): `GET /devices?include=keys&all=true` (device bearer only) returns `public_key`, `revoked_at`, the signed recipient with its set time, `server_time`, and revoked and expired devices (ES-01 §8, §8.1). §8.1 exists since e4a75cc. Row ID-21 tests it.
- C3 (R5/R6): §8.1 R5 states the key-directory model and the endorsement validity rule. An endorsement is valid only if the endorsed device's server-clock `created_at` precedes the endorser's `revoked_at`. An endorsement dated after the endorser's revoke is void. Revoking a device does not revoke the devices it endorsed. The first device is self-trusted.
  - §3.1 makes `created_at` and `revoked_at` server-clock values that are never moved.
  - A pinned device whose key or timestamps change is surfaced as a registry fault.
  - The endorsement file and decision D-9 stay with ES-02.
  - R6: the list makes additions, key changes and revokes observable and carries name, os, created_at and fingerprints. Showing the notice is ES-02's job.
- C5: `idle_expiry` is removed from `revoked_reason`. Idle expiry sets `status=expired` and leaves `revoked_reason` and `revoked_at` null; only `revoked` sets them (§3.1, §5, R4). ID-21 tests this.

snyk: NOT_APPLICABLE_DOCS

blockers: none for the specs.
- telepty is not on PATH, so this file is the evidence fallback. It is not proof of delivery.
- Open for the orchestrator/user: D-Q-1 (no default); the new Rule 47 rows above; the conditional macOS default in D-ID-2.
