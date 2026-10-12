REPORT: oc-1204-ctxws2 task #2026101204 — CONTRACT SPEC FIX 1 — DONE

Scope note: DONE refers only to this specification fix cycle (ES-02, ES-04, ES-07, ADR) against REVIEW.md (oc-1204-rev1, verdict REVISE). Nothing is implemented, merged, released or installed. Parent task #2026101204 stays open (Rule 45 §2, Rule 50 §2). Transport: `telepty` is not on PATH and `TELEPTY_SESSION_ID` is empty in this sandbox, so this file is the fallback. Per Rule 7 a file is evidence only and does not count as receipt; the orchestrator must still pull it.

commits (branch task-1204-env-continuity-ctxws, on top of a32ea02, not pushed):
- df713c8 remove stray tool-call markup (non_blocking 1)
- 224636b line-12 guarantee + no-GUI rows (blocking 1)
- 0372553 ES-04 unpushed-range scan / refusal / no-upstream base (blocking 2)
- 1cc829d signing, reader-side revoke, requirements on ES-01, S1 limit (blocking 3)
- 2bc855a ES-07 ledger-exact states (blocking 4)
- 1cddadc PTY claim → not measured; N3/N4/G2/P2 split (blocking 7)
- 45ed9a0 D-7 + D-4 extension (blocking 6)
- dbdf2ea ES-02 non-blocking fixes
- ec8ae08 ES-04/ES-07/ADR non-blocking fixes
- 636b33a matrix columns, ES-07 line-52 non-claim + real-endpoint row (blocking 5)
- af54100, a1ec731, af66b68 cross-doc consistency (metrics fields, ES-07 ES-01 dependency, D-8 category, row count)

resolved:
1. GUI/cmux/telepty-daemon-only `[REQ line 12]` `[DRAFT line 9, 27]` was added as ES-02 N5, ES-04 G6 and ES-07 P5. Each one splits the restated requirement from the applied new rule. The only evidence of completion is reader-verified ids/hashes (ES-02), the manifest + journal + hashes (ES-04), or the §3 `evidence.source` enum (ES-07). Log copies and SSH output never count. Test rows: CK-16, WS-14, DG-11 (cmux absent, no GUI session).
2. New ES-04 §3.4 "Unpushed commits":
   - Base: upstream; else `merge-base HEAD <remote>/<default>` from `refs/remotes/<remote>/HEAD`; else a user-named `--base` contained in a remote-tracking ref; else `CAPTURE_BASE_UNDEFINED` (metadata only). The whole history is never bundled.
   - Scan of `base..HEAD`: paths touched (including ones deleted again later) against the §3.1 deny-list, added blobs with the detectors, and commit messages.
   - On a hit: `CAPTURE_SECRET_IN_UNPUSHED_COMMIT` refuses the whole repo bundle, with `refused{code, hits[{commit,path,detector}]}`. History is never rewritten and logs carry no matched text.
   - Also updated: §2.1 `unpushed_commits`/`refused`, §4 step 3, §7 codes, ADR A7. Fixture row: WS-02b.
3. Writer authentication:
   - ES-02 §2 gets a `signature` field (Ed25519 by the ES-01 device key over `aigentry-checkpoint-v1|user_id|checkpoint_id|content_sha256`). `integrity` now excludes `signature`.
   - New §5.4 reader-side rules: integrity; signer = `device_id` = path, and in the authenticated, trusted list; signature valid; `user_id` match; revocation (`created_at ≥ revoked_at` → `CHECKPOINT_DEVICE_REVOKED`; backdated and unanchored → `CHECKPOINT_REVOKED_WRITER_UNANCHORED`; ES-01 `expired` ≠ revoked). Device-list cache shows `fetched_at`.
   - New §5.5 "Requirements on ES-01", R1–R7: per-device signing key (met); per-device signed `age_recipient` (missing in ES-01); list returning keys + `revoked_at` + revoked devices; immutable server-clock `revoked_at`; key-directory trust model with endorsement by an already-trusted device; user-visible recipient-change notice; R7 = ES-01 §7.2/§7.3 rows for ES-02/ES-04 cannot hold under Git storage, so enforcement is reader-side.
   - §5.3 states the S1 known limit and the required GitHub-credential revocation step (ADR D-8).
   - ES-04: manifest `signature` over `content_sha256|bundle_sha256`; §4 step 4 signs; §6.1 verifies with the same rules; S1 limit added in §5; new `RESTORE_SIGNATURE_INVALID/WRITER_UNKNOWN/DEVICE_REVOKED`.
   - Test rows rewritten as reader-side rejection: CK-11 (post-revoke / backdated / forged), new CK-11b (trust/notice), CK-04 extended, WS-10 (a)–(d), WS-11.
   - ADR: A4 now says "trusted", plus new A4b, consequences, D-8 and D-9.
4. ES-07 §3.1 rewritten:
   - `observed` applies whenever there is evidence, finished or not.
   - `pending` only when lifecycle is `active`, there is no evidence, no later hop has evidence, and the request is not finished.
   - `unknown` covers `SKIPPED_STAGE_NO_EVIDENCE` (ledger 124–125), `DEADLINE_PASSED` (155–157, 214) and `NO_HOP_EVIDENCE` for finished requests.
   - `expired` is set exactly when `ledger_status == expired` (158–160, 215), never from a TTL or outbox. A retired record that had finished keeps its status.
   - Explicit evaluation order. New finding row: lifecycle table 211–215.
   - Rows: DG-05 rewritten (a/b/c), plus DG-05b, DG-12, DG-13.
5. All three matrices gained Measures | Does not measure | Runnable now | Blocked on, with a column legend: BLOCKED is never PASS, and a Linux-fixture PASS is never cross-platform or real-endpoint PASS. ES-02 and ES-04 add a note that fixture rows use a stub ES-01 identity.
   - BLOCKED: CK-01 (ES-01, ES-03), CK-03, CK-04, CK-11, CK-11b (ES-01; D-9); WS-10, WS-11 (ES-01); WS-12 (macOS/Windows runners; Mac offline, line 60); DG-02(b) (PTY source); DG-03 last-seen variant (ES-01 `last_seen_at`); DG-04 remote (telepty #100); DG-16 (#100, #103/#104, RC5/#107, PTY source, second host).
   - ES-07 gets P6 (line-52 non-claim) and the real-endpoint row DG-16, marked BLOCKED.
6. ADR §6:
   - D-7: separate checkpoint-upload opt-in, distinct from `enableSync`. Recommended: `manual` + `session_end` only; `compact`/`dispatch_report` off until enabled; `interval` off.
   - D-4 extended to automatic non-deletion writes: rekey automatic within limits; import and endorsements only on explicit command.
   - New D-8 (revoked-device Git access) and D-9 (key-directory trust).
   - Numbering D-1..D-9 is consistent across ADR, ES-02 (N4, §3.1→D-1, §5.1, §5.3, §5.5, §7, §8→D-3) and ES-04 (§5→D-8).
7. (a) ADR finding 5 and ES-07 §0.2 now say only that the telesession spec defines no PTY-write evidence. A search finds no `PTY` in it, and telepty mappings are only lines 318/327/339. "Whether telepty can observe a PTY write" moved to §0.3 not measured. The `pty` reason was renamed `PTY_EVIDENCE_UNAVAILABLE`, and DG-02 was rewritten.
   (b) N3 → `[REQ 39][DRAFT 44]` restated part + an untagged new rule (hash-verified only). N4 → `[REQ 16]` part + an untagged new proposal (D-7). G2 → `[REQ 51][DRAFT 57]` preserve part + untagged new-worktree default. P2 → `[EXISTING 142]` part + untagged read-only-view rule. The dispatch said "re-tag as `[DRAFT]`", but the draft does not contain these new rules, so they are left untagged (= new proposal requiring review) rather than given a false `[DRAFT]` tag.

non_blocking_applied:
- 1: stray markup removed from all 4 docs; REPORT.md overwritten.
- 2: TOFU nuance in ES-02 §0.1, ES-04 §0.1 and ADR finding 2 (`GitBackend.ts:132`, `ProfileFormat.ts:256-277`).
- 3: ES-02 §4.4 row "checkpoint commit independent of profile merge outcome" + CK-17.
- 4: ES-02 §0.2 finding on `origin/release/0.2.5` `1d8a600`/`ac94b35`; §7 `compact` trigger covers non-Claude CLIs; per-CLI availability not measured (§0.3); ADR finding 6.
- 5: disclosed in the opt-in text (D-7) at ES-02 §4.1; keyed hash declined (see below).
- 6: hash over redacted text in every mode (ES-02 §3, §3.2).
- 7: same-path/same-bytes = idempotent no-op (§4.1) + CK-18.
- 8: `sync_state` written→committed→pushed with wording rules (§5.1) + CK-19.
- 9: `rejected` hop derived from the destination-only rule (ledger 165–166): `agent` + `final_reply`; DG-04 updated.
- 10: access_layer mapping (relayed only, relay off by default; direct send → `NO_ACCESS_LAYER_SOURCE`; queued/intent/sent/failed/uncertain/quarantine mapped) + DG-15.
- 11: 50 MiB cap vs host limits → not measured; Windows owner-only ACL; per-repo confirmation recorded in the journal as runtime consent.
- 12: ADR §7 restates 32–64 as an unverified placeholder; signing/ES-01 key interface and the telesession-side §4 change added as unestimated.
- 13: CK-12 reworded to "identical content items for identical state", including the setup hint (`BrainMcpServer.ts:313-321`).
- 14: `redactionViolations` finding (`shadow-evaluator.ts:13,52`).
- 15: `offline` source marked as an ES-01 dependency (§3.1, §3.2, header).
- Coverage gaps also applied: log hygiene for secrets (ES-02 §3.2, ES-04 §3.4), late ACK row DG-14, CK-01 checks `source_session` + evidence refs (line 48).

declined:
- non_blocking 5, keyed hash for path keys: it needs a per-user secret shared by all devices. None exists (ES-01 keys are per device), and adding one is a new key-distribution design. The exposure is disclosed in the D-7 opt-in text instead. If the user wants it, it can be revisited together with D-9.
- Dispatch item 7 wording "re-tag as `[DRAFT]`": not literally applied, because the new rules are not in the draft. They are untagged instead, which is the convention's marker for "new proposal, needs review".

new_decisions:
- D-7: checkpoint-upload consent + automatic triggers (개인정보 전송).
- D-4: extended to automatic non-deletion writes.
- D-8: revoked device's remaining Git access, with a required credential-revocation step (개인정보 전송).
- D-9: key-directory trust, endorsement vs registry-only (개인정보 전송).
- Technical (orchestrator can decide): signature message formats, reader evaluation order, ES-07 state evaluation order, new error/reason codes.

grounded_in (new reads this cycle):
- telesession-wt-1110 `docs/specs/2026-10-11-e2e-delivery-protocol.md`: 45–200, 200–262, 270–330, 330–430. Used lines: 76 (terminal has no hop), 124–125, 142–160, 165–166, 211–215 (lifecycle), 222–232 (quarantine), 307, 318, 327, 339, 357 (fake-receipts), 373, 383, 399. A search for `PTY` returns 0 matches.
- Sibling ES-01 spec (wt-1204-idq @ e2269f3) `docs/specs/2026-10-12-env-continuity-identity.md`: §2 (Ed25519 per device), §3.1 (`public_key`, `revoked_at`, `last_seen_at`, no age key), §4 (`aigentry-device-v1|` prefix), §5 (expired re-binds), §7.2/§7.3 (registry-transaction revoke rows for ES-02/ES-04), §8 (list fields), §9 (`--all`).
- brain @ 0ffa6ee: `GitBackend.ts:128-136`, `ProfileFormat.ts:254-279`, `PushPullManager.ts:136-150`, `BrainMcpServer.ts:310-324`, `shadow-evaluator.ts:13,52`, `src/cli/hooks/` listing.
- orchestrator: `git log origin/release/0.2.5 -- bin/context-compact.sh` → ac94b35, 1d8a600, f088080.
- Requirement lines 1–68; draft lines 1–99 (line 36 device-key signing, 44, 57).

not_measured:
- telepty source/daemon APIs (including whether a PTY write is observable) and the registry deployment.
- Whether ES-01 will accept R2–R7; the sibling spec was not edited.
- Git-host per-file/push limits; real multi-host runs; macOS/Windows.
- age `ssh-ed25519` recipient reuse vs a separate X25519 key: proposed separate, not evaluated further.
- No tests run (SAWP). No compile step applies to docs. The compile-check analogue was done: every matrix row has all 8 cells (awk check over CK/WS/DG rows, 0 violations).

snyk: NOT_APPLICABLE_DOCS

blockers: none for this dispatch. Open dependencies for the specs themselves: ES-01 R2–R7 (age recipient, list fields, endorsement, R7 wording) must be taken up by the ES-01 owner, and user decisions D-1..D-9 are pending.
