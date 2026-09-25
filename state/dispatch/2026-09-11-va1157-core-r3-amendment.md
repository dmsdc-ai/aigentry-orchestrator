---
dispatch_kind: continuation
---
# #1157: bounded R3 consistency amendment

Existing worker va1157-architect, architect. Review target 194db1bd22e4e6377c8e9755b562d7d0915956f7. R3 improves crash uncertainty, full question identity, real playback completion and grant enforcement. It is NOT approved for implementation. This is one narrow in-place consistency amendment, not another architecture rewrite or research round.

Only authored file: /Users/duckyoungkim/.aigentry/worktrees/va1157/docs/specs/2026-09-11-voicecode-core-contract.md on docs/1157-voicecode-core-contract. UI proposal 7764ddb is now preserved unchanged on main at /Users/duckyoungkim/projects/aigentry-orchestrator/docs/specs/2026-09-11-voicecode-design-contract.md (blob 5b8a20abe53780683ee493dfece8fd43b0533369); the UI worker has been cleaned up. Do not contact it or edit the UI document.

## Four concrete consistency findings
1. Resend identity and racing originals (core lines 80-96 vs UI sections 8/9): the report claims a new command with resend_of follows the UI's original-identity/no-new-request invariant, but the contract currently has only client_seq as request identity. Explicitly separate a stable logical request identity from any transport-attempt sequence if that is your intended design; keep the original target and payload bound, never silently create a new logical request. A delayed original arriving before a replacement must make the replacement non-executable, not execute twice. Eligibility, original fencing and one authorized retry allowance need one durable atomic decision, checked again at admission, including concurrent connections and host restart. An unavailable adapter proof is still unknown. If this cannot be specified within the current one-forward-attempt policy, retain the conservative no-resend state and state the missing reviewed capability instead of claiming UI alignment. No provider call or crash test now; add a delayed-original/resend counterexample fixture.
2. Authority invalidation is not provider question closure (core lines 99-105/162 vs UI section 6.2): question_closed(reason=authority_invalidated) and snapshot replacement can remove questions although the provider may still be waiting. Paged snapshots are explicitly partial, so absence from open_questions is also not proof of closure. Give local invalidation/revalidation and page membership a nonterminal representation, preserving inaccessible/held counts and voice access; reserve terminal closure for observed provider closure or authoritative supersession with an explicit successor. Do not make a consumed admission ack equivalent to a provider-completed answer. The sentence allowing commands after the user acts on unknown provider state must not silently bypass the reconciliation fence; describe the safe recovery action or keep the fence until observed reconciliation. Specify fixtures for restart with an unobservable still-waiting provider and a paged snapshot omitting a previously shown question.
3. Command-specific admission (core lines 80-82/113-130): the generic path requires a valid grant and a live unfenced session, but revoke is explicitly grant-free and should work for an expired/exhausted grant or a fenced/disconnected session when the host is reachable. Specify a separate authenticated, owner-bound revoke admission branch with durable idempotence and no grant use, no requirement for a live agent session. Offline local stop remains unconfirmed remotely. Keep rejected commands from appearing admitted or consuming use. Add expired-grant/fenced-session revoke fixtures.
4. Defer is not an answer that closes the question (core lines 103/123): the universal answer rule consumes and forwards every decision including defer, which conflicts with later statements that deferred/out-of-scope questions stay pending. State exact defer semantics: nonterminal, no provider answer/denial synthesized, no consumed tombstone or grant use, safe idempotent postponement/readback behavior. Distinguish deny's actual provider-bound decision and admission from confirmed provider closure. Define command-specific validation for these rows without weakening allow/gated choice/cancel. Add defer-then-readback-and-answer and lost-answer-ack fixtures.

## Scope and finish
These are contract counterexamples from source reading, not reproduced runtime bugs. Preserve all corrected facts/invariants; no line-count target and no edits merely to make a string check green. Add a short correction map and specified-but-unrun fixtures. Core S1 then UI D remain serial for MainActivity. All user choices C1/C2/C3 remain unanswered; do not infer consent, privilege scope, duration, cloud transfer, paid calls or dependency approval. No extra user survey.

[SPEC FIRST] Documentation only. No implementation, builds, tests, app/device/daemon execution, installs, model downloads, credentials, paid calls, merge, push, nested work or extra authored files (including memory). The prior two disclosed memory files remain untouched. Product /Users/duckyoungkim/projects/voicecode is read-only at 5d98d60d8b48b7eb170115a2492ddf5e0433106c with prior deleted .omc/state/subagent-tracking.json and untracked .claude/ preserved; do not open private configuration. state/ and bin/ are orchestrator-side metadata, not worker authoring targets.
Use /Users/duckyoungkim/.codex/tmp/arg0/codex-arg0gVYpHq/apply_patch for the sole document. Use all necessary available skills/tools within this scope; no substitute write tools. Recheck exact branch/WT/main/source currentness, review, commit, then execute BOTH actual reports:
telepty inject --ref --submit --submit-force --from va1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: va1157-SPEC-R3-AMENDMENT | task: #1157 | file: docs/specs/2026-09-11-voicecode-core-contract.md | include commit/currentness, four consistency outcomes and remaining unrun fixtures/blockers; no implementation/build/test"
telepty inject --ref --submit --submit-force --from va1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: va1157 | task: #1157 | phase: amended r3 review | needs: reviewed contract and outstanding human decisions before implementation"
On an actual blocker send a factual HOLD immediately; no silent wait or unauthorized substitution.

## [SAWP]
Architect documentation only; coder instructions below do not authorize builds/tests.
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error -> fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts -> report STUCK with full error
- Never idle - report immediately when done
- Evidence only - no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)
Snyk N/A for documentation; future first-party code requires fix-rescan before DONE.
