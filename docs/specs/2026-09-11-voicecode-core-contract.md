# Voice Code thin voice remote — core runtime, message and audio contract (#1157), r3

**Status**: SPEC r3 — targeted in-place corrections of r2 `8508dd6` (reviewed, not approved; r1 `326425e` rejected). Design only: no implementation, build, test, install, app/daemon launch, model download, credential use or paid/API call. This revision approves no grant scope, sensitive class, duration, limit, dependency or engine; implementation waits for review and the open human decisions (§15). Core owns runtime, messages, audio, the foreground service, manifest and notification wiring; ui1159 renders the semantic states of §8 (UI contract `7764ddb`, `/Users/duckyoungkim/.aigentry/worktrees/ui1159/docs/specs/2026-09-11-voicecode-design-contract.md`).
**Currentness**: source `/Users/duckyoungkim/projects/voicecode` @ `5d98d60` (`main`), dirty state unchanged since r1 (` D .omc/state/subagent-tracking.json`, `?? .claude/`, not opened). Branch `docs/1157-voicecode-core-contract` @ `8508dd6` before r3 (r2 `8b48e15` + SSH-size amendment), base `606d4ae`; local `main` `f4bed5b` at 2026-09-11T11:24Z (base is its ancestor; `base..main` does not touch this file); `origin/main` `a536cd8`.
**Labels**: S = source `file:line` @ `5d98d60` · D = official doc (§16) · U = unknown + smallest verification · P = proposal (numbers and defaults are proposals, not measurements or approvals). Kotlin paths are under `android/app/src/main/java/com/voicecode/app/`, TS under `bridge/src/`.

## 0. r1 → r2 correction map

| # | r1 defect (review) | r2 resolution |
|---|---|---|
| 1 | Default "no voice approvals, approve at the desk" replaced the screen-free workflow; binding covered approvals only | §5: an explicitly paired, user-signed, scoped session grant makes in-scope approvals, answers, prompts and cancels hands-free, with provenance and binding for each; sensitive classes stay a human decision (C2); a missing provider channel is blocker B3, not a UX substitute; no bypass |
| 2 | Voice loop left in the ViewModel whose `onCleared` destroys it; "headset button always interrupts" | §7: the existing foreground service owns session, transports and audio from the first production slice (S1); process loss, fold recreation, single ownership and no view-size dependency (F-k) specified; activation and interruption paths are device-gated (V4, V7, V9), blocker B2 |
| 3 | Evicting 256-`req` cache claimed at-most-once; answers bound to an approval digest only; ring called at-least-once | §4: per-client durable high-water mark with retained window and `req_too_old`; payload-bound ids from the authenticated client; answers bound to host/epoch/session/task/qid/`q_rev`/`q_digest` for every kind; atomic consume, ack and `unknown`; gaps resolve through an authoritative snapshot |
| 4 | "Outcome word + agent prose" did not stop contradictory success claims | §6: structured, source-linked summary; mandatory fields from machine events; reported vs observed vs verified attribution; prose only as a suppressible attributed quote; 12 counterexample fixtures, 100 % required |
| 5 | Pending question state tied to playback | §8: ledger separate from audio items; per-item planned/queued/speaking/interrupted/completed; dedup by `(qid,q_rev)`; bounded overflow even when every item is a question; semantic states for UI |
| 6 | ChatGPT folded into Codex exec; auth only declared | §3: ChatGPT and Codex separate; Codex through app-server (structured approvals); consumer-thread access not provided and unverified; declared vs verified auth; ambient keys scrubbed; provider terms are gate B1, not user consent |
| 7 | Builtin engines declared the default; researched engines postponed | §9: builtin is a measured baseline; pluggable STT/TTS seam with streaming, warm reuse, cancel and actual-engine reporting; comparison slices; split end-to-end latency (§10) |
| 8 | Hand-rolled MCP; ownership vague; too many user questions | §13: maintained dependency proposed for review; core owns service, manifest and notification; shared files serialize; §15 keeps three real choices |

**r2 → r3 (targeted corrections of `8508dd6`):**

| # | r2 counterexample | r3 correction |
|---|---|---|
| 1 | A durable `admitted` record was read as proof of `lost_before_delivery`; `req_too_old` was read as "not executed"; `last_admitted` alone classified old commands | §4 crash/receipt/retention matrix: after admission, anything short of adapter proof is `delivery_unknown`; below the retained range is `evidence_expired`; per-command `cmd_status`; resend only when resend-safe; fixtures CX1–CX4 |
| 2 | `(qid,q_rev)` keys collided across epochs; a host restart was assumed to end provider questions and processes | §4 full question key `(host_id,epoch,session,task,qid)` + content identity everywhere; restart invalidates local authority only, fences and reconciles sessions or reports unknown, re-issues with `supersedes`; owned-process rule; snapshots never restore answerability |
| 3 | An interrupted question requeued once became `completed`; the 8-item audio cap did not bound the ledger | §8 completion only from engine completion of every required part; a second interruption → `blocked`; completed ≠ heard; ledger capacity with host paging and honest held counts; fixtures PX1–PX3 |
| 4 | Grant expiry, revocation and use limits were phone-side; signed bytes ambiguous; the challenge overclaimed; test/build commands treated as safe by prefix | §5 host-validated grant with an atomic use count in the admission write; local stop vs confirmed revoke; signature over exact transmitted bytes with platform crypto; challenge = correlation only; grant recorded as the authority; consistent deny/defer, text, typed and cancel rows; no command allowance without a verified sandbox |
| 5 | F-k overstated; UI invariants and `MainActivity` ownership unaligned; raw terminal unstated | F-k limited to cold start with no prior size; UI `7764ddb` invariants reused (resend-safe/unknown with the original identity, playback ≠ hearing, separate location/billing/consent, typed input under the same authority); phased `MainActivity` ownership (§13); raw terminal passthrough stays an unauthorized capability (F-l, §5) |

## 1. Decision

The Node bridge becomes the one **connector host**: it runs the user's own agents through structured adapters, owns their sessions and emits one versioned event protocol (§4). The phone's foreground service owns microphone, STT, TTS, the pending-question ledger, playback and signed user commands. A PC is optional: the same WebSocket is forwarded over the existing SSHJ link, without PTY scraping. No cloud hub, no mandatory PC/GPU, no scheduler, no second general agent, no bypass mode. The SSH-terminal mode stays manual-only, with the §12 fixes and no voice authority.

## 2. Measured facts (S @ 5d98d60)

| # | Fact | Evidence |
|---|---|---|
| F-a | Engine choice is UI-only: `speak()` always uses Android TTS (default `kokoro`); the STT choice is stored and never read; the recognizer is `createSpeechRecognizer`, `ko-KR` | `voice/VoiceEngineManager.kt:30,65-67,95-110`; `session/SessionStore.kt:161`; `voice/SpeechManager.kt:112,118-144` |
| F-b | Bridge drives Claude CLI only: per message `claude -p --output-format stream-json`, `--resume <id>` else `--continue`; busy → reject; SIGTERM kill; `result` text ignored; parser reads top-level `content/message/text` (vs documented schema: U until fixture); stderr becomes spoken errors | `claude-cli.ts:38,89-109,138-147,185-192,269-275,300-340` |
| F-c | Wire protocol: no version, ids, sequence, binding or question frame; frames dropped while no client is attached; `send()==true` only means enqueued | `protocol.ts:13-19,35`; `ws-server.ts:290-301,375-386`; `network/BridgeClient.kt:56-60` |
| F-d | Exposure: first local client accepted without auth; CORS `*`; open `/api/tts`, `/api/stt`; `config` replaces keys; launch kills the port owner and runs `/sdcard/voicecode-bridge-update.js` | `ws-server.ts:81-84,158-160,177-225,233-240,304-320`; `termux/TermuxLauncher.kt:88-99` |
| F-e | SSH: `PromiscuousVerifier`; uncaught writes; reconnect lands in a bare shell without auto-launch | `ssh/SshSessionManager.kt:128-151,188,272-279`; `viewmodel/MainViewModel.kt:1038,1063-1091` |
| F-f | Voice router: `취소/멈춰/중지/stop` (and "취소 …" prefixes) send Ctrl+C (0x03), so "stop talking" kills the task; `네/yes` sends `y` + newline with no bound question | `ssh/VoiceCommandRouter.kt:16-19,26-36`; caller `MainViewModel.kt:1277-1283` |
| F-g | Playback: HIGH = `stop()`+`clear()` (a later error erases a pending question); unbounded FIFO; `QUEUE_FLUSH` per utterance; barge-in clears everything; no `AudioAttributes`, focus or route API | `voice/TtsManager.kt:33,95-105,134`; `voice/BargeInController.kt:59-62`; grep: only the drone sets attributes (`MainViewModel.kt:625`) |
| F-h | Lifecycle: tap-only trigger; `onPause` cancels recording and speech; `onCleared` destroys bridge, SSH, STT, TTS and engines; the FGS is `specialUse`, `START_STICKY`, holds only a wake lock and churns on every SSH connect/disconnect | `ui/VoiceButton.kt:89`; `MainViewModel.kt:868-881,1210-1226,1414-1435`; `ssh/SshForegroundService.kt:35-51`; `AndroidManifest.xml:8,34-37` |
| F-i | Raw text is spoken (bridge errors, first INFO line, screen scrape after 1.5 s quiet); transcript, frames, spoken text and key prefix are logged; secrets are plaintext; the `gpt-4o-mini` summarizer runs whenever a key exists | `MainViewModel.kt:291-297,391-406,1218,1267,1294,1356-1358`; `engine/ContextCompressor.kt:256-273`; `BridgeClient.kt:109`; `TtsManager.kt:86,90`; `SessionStore.kt:23-31` |
| F-j | Tests: 3 JVM files (router, ANSI, injectable barge-in `BargeInController.kt:22-31`); bridge has `typecheck` only; no CI | `android/app/src/test/…`; `bridge/package.json:10-15` |
| F-k | Cold-start view dependency (reported by #1159 r2, re-read here): `_terminalSize` is null until the terminal view first composes, and `connectSsh` defers via `pendingSshConnect` until `resizeTerminal`; if no size has ever been reported (e.g. the terminal view is never composed), SSH never connects. A reported size persists, so later off-screen states do not block; every size report resets the emulator and resizes the PTY | `MainViewModel.kt:143-145,1029-1034,1240-1256`; `ui/TerminalView.kt:140-143`; composed at `ui/MainScreen.kt:227,246` |
| F-l | Raw terminal passthrough: the terminal view's paste action and hidden typeahead field send text and keystrokes straight into the SSH shell | `ui/TerminalView.kt:218-276` → `MainActivity.kt:92` → `MainViewModel.sendRawTerminalInput:1259-1263` → `SshSessionManager.sendInput` |

Call chains (S): listen `VoiceButton.kt:89` → `MainActivity.kt:74` → `startRecording:1210` → `SpeechManager.startListening` → `sendMessage:1265` → `BridgeClient.sendCommand` or `VoiceCommandRouter.route` → `SshSessionManager.sendInput/sendLine`; speak `handleIncomingMessage:1293` or `processTerminalScreenForTts:314` → `VoiceEngineManager.speak` → `TtsManager.speak`; bridge `ws-server.ts:326-345` → `ClaudeCliManager.sendInput` → `attachCliEvents:349-371`.

## 3. Ownership, providers and auth

| Concern | Phone (service-owned) | Connector host (bridge) | Agent / provider |
|---|---|---|---|
| Mic, STT, TTS, ledger, playback, route | owns | — | — |
| Prompts, answers, cancels | signs within a grant (§5) | admits, validates the grant, verifies binding, forwards | executes under its own permission system |
| Model, context, tools, execution | — | per-profile flags | owns |
| Auth and billing | never sees provider credentials | scrubs env, reports declared vs verified | owns |
| Originals and summaries | renders §6 templates | builds the §6 summary from machine events | produces text and events |

**Profiles** (P: `~/.voicecode/profiles.json` on the host): `{profile, product, connector, auth_declared: subscription/api_key, model?, project, permission_mode (never bypass), protected}`; the host adds `auth_verified: subscription/api_key/unknown` and `terms: corroborated/unverified`.
- **Declared ≠ verified.** Connectors are spawned with provider key variables removed (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`) unless the profile declares `api_key`. Config-file credentials cannot be scrubbed that way, so the adapter reads the connector's own auth report (field per connector U → fixture, B4). A subscription profile whose `auth_verified` is not `subscription` gets `auth_mismatch`/`auth_unverified`: the turn is refused and spoken, never silently billed. No automatic switch and no paid fallback.
- **Provider terms (B1).** Subscription-driven programmatic use needs corroborated provider terms; user consent is not provider authorization.

| Product | Connector (user-installed, user-logged-in) | Structured channel (evidence) | Questions | Session reuse |
|---|---|---|---|---|
| Claude | Claude Code `claude -p` | `stream-json` in/out, `--permission-prompt-tool`, `--append-system-prompt` (D) | yes, via the permission tool (fixture U) | `--resume <id>` of host-listed sessions (D) |
| Codex | Codex app-server (structured approvals and events, reviewer-cited learn.chatgpt.com/docs/app-server; method names U → fixture); `codex exec --json` (D) only as a no-question fallback | app-server | app-server: yes after fixture; exec: none (B3) | app-server threads; `codex exec resume <id>` (D) |
| ChatGPT (consumer app threads) | none in this implementation | — | — | existing phone-app thread access is unverified and not provided here; not claimed impossible for every connector/API |
| Gemini | Gemini CLI `--output-format stream-json` (D) | events `init`…`result` (D) | U (B3) | U |
| Grok and others | OpenCode `run --format json`, `serve` + `--attach` (D) | JSON events | U (B3) | `--session` (D) |

Session reuse happens only through structured adapters and host-listed sessions; never raw PTY injection, and never into a `protected` session such as the orchestrator.

## 4. Event protocol v1 (JSON frames on the existing WebSocket; SSH-forwarded when a PC is used)

**Pairing and connection.** Setup (screen on) creates a non-exportable Keystore key pair on the phone, and the host stores the public key under a `client_id`. `hello{v_min,v_max,client_id,sig(host challenge),resume?{host_id,epoch,after_seq},pending[client_seq…]}`: unpaired client or bad signature → close 4401; any `Origin` header → 4403 (OkHttp sends none: U, checked in G1); no common `v` → 4426. This proves the paired device, not the user (§5). Host frames carry `host_id` (per install), `epoch` (per process start) and `seq`.
**Commands** (`prompt`, `answer`, `cancel`, `revoke`) travel as `{body, sig}`. `body` is one exact UTF-8 JSON string holding type, `client_seq`, target ids, payload, `grant_id` and proof; the host parses those bytes and never re-serializes them. `h` = SHA-256 of the `body` bytes; `sig` = the paired Keystore key's ECDSA P-256/SHA-256 signature over the same bytes, verified with Node `crypto` — platform primitives only, no hand-written cryptography or canonicalization; `h` and `sig` sit outside `body`. `client_seq` increases by one per command and is persisted on the phone. `client_id` comes from the authenticated connection, never from the body.
**Admission (durable, before any side effect).**
- `client_seq > hwm`: check scope (paired, session live and not fenced, grant valid and covering the command, §5) → one durable write (P: `~/.voicecode/clients/<client_id>.json`, fsync) of `{hwm = client_seq, h, state: admitted}` together with any question consume and grant-use increment → forward (the external side effect) → durable `forwarded` → `ack{client_seq, status, task?}`. Forwarding happens only after that write, so a command without an admission record was never forwarded.
- `client_seq ≤ hwm` inside the retained range (the last 64 seq numbers per client, P; `welcome.retained{from,to}`): a record with the same `h` → the stored ack, and nothing re-executes; a record with a different `h` → `req_conflict`; no record → `never_admitted` (provably never forwarded; the seq is dead and never executes later).
- `client_seq` below the retained range → `req_too_old`, meaning `evidence_expired`: it may have executed before its record was evicted. It is never executed now and never reported as "not executed"; the phone says "확인 기간이 지나 실행 여부를 알 수 없어".
- At most one forward attempt: the host never re-forwards an `admitted` command after a restart. The phone may resend the identical `{body, sig}` once after one reconnect within 30 s (P), which is dedup-safe, and never re-issues automatically under a new seq. `last_admitted` alone classifies nothing: the host answers each `hello.pending` seq with a `cmd_status` from the matrix below.
- Resend (UI `7764ddb` §8/§9 invariant): only a resend-safe command (`never_admitted`, or `not_forwarded` proven by adapter reconciliation) may be resent, by voice or on screen, as a new command carrying `resend_of: <original client_seq>`; the host accepts one resend per original. `delivery_unknown` and `evidence_expired` are never resend-safe: the phone says "실행됐을 수 있음, 원문 확인" and resends nothing.

| Host crash point | Durable record after restart | `cmd_status` | Needed to say more |
|---|---|---|---|
| before the admission write | none, seq in range | `never_admitted` (resend-safe) | — |
| after the admission write, before the forward call | `admitted` | `delivery_unknown` | adapter reconciliation proving absence → `not_forwarded` |
| after the external forward, before the `forwarded` record | `admitted` | `delivery_unknown` | adapter receipt proving presence → `forwarded` |
| after `forwarded`, before a result | `forwarded` | `forwarded`, outcome unknown | provider session reconciliation |
| record evicted from the retained range | none, seq below range | `evidence_expired` | none available |

Adapter receipts and reconciliation are connector-specific (e.g. a provider turn id, or a transcript entry keyed by the command identity): U per connector, captured as fixtures in S3/S7 (B3). Crash fixtures (specified, not run): CX1 kill the host after the admission write and before forward → `delivery_unknown`, no re-forward; CX2 kill it after the provider received the prompt and before the `forwarded` record → `delivery_unknown` (or `forwarded` with a receipt), no duplicate turn; CX3 execute, evict with 64 newer commands, redeliver the old frame → `evidence_expired`, not executed again, spoken as "may have run"; CX4 an in-range seq that was never admitted → `never_admitted`, one resend accepted with `resend_of`.

**Host frames.**
- `welcome{v,host_id,epoch,host_version,caps,retained{from,to},cmd_status[{client_seq,status,resend_safe}],profiles[…]}` (`cmd_status` holds one entry per `hello.pending` seq), then either a ring replay (same `host_id` + `epoch`, retained `after_seq`; the ring holds the last 512 events or 1 MiB, P) or `snapshot{epoch,seq,sessions[{session,state: live/reconciling/unknown,tasks[{task,state,started_by}]}],open_questions[full frames up to the phone's ledger_capacity],held_count,recent_results[≤10],dropped{results,statuses}}`.
- The snapshot is authoritative. The phone replaces its view and reconciles the ledger by question key + content identity (below). Every readback is invalid after a snapshot, and a completed audio item never restores answerability: a question needs a fresh bound readback in the current epoch (§8). The phone speaks one line about the gap. A gap never causes a reconnect loop; reconnects happen only on transport failure, with the existing backoff.
- `question{host_id,epoch,session,task,qid,q_rev,content,q_digest,sensitivity_class,truncated,expires_at?,supersedes?}`, where `content` is one exact UTF-8 JSON string of `{kind: approval/choice/text, prompt_text, action?{tool,target,scope,args_ref}, options?[{id,label,action_class?}]}` and `q_digest` = SHA-256 of those bytes, for every kind. **Question key** = `(host_id,epoch,session,task,qid)`; **content identity** = `(q_rev,q_digest)`; `q_rev` increments on any content change. Snapshot reconciliation, the ledger, audio items, dedup, `question_closed`, `answer` and readback proofs all use key + content identity, so a new epoch reusing `q1`/rev 1 inherits no playback state or authority. Closed by `question_closed{key,q_rev,reason: answered/expired/cancelled/superseded/provider_closed/authority_invalidated}`.
- `status{session,task,state}` (earcon only) · `result{session,task,result_id,summary(§6),original_ref,truncated}` · `error{code,retryable,client_seq?,session?,task?}`.
**Answers.** An `answer` body (`client_seq, key, q_rev, q_digest, decision: allow/deny/defer/option/text, option_id?, text?, input: voice/typed, grant_id, readback_id`) is valid only if the key and content identity equal the currently open question, the grant is valid and covers it (§5), and the paired key signed the exact body bytes. Inside the admission write the host marks the question `consumed` (tombstoned for its key) and, for authority-bearing decisions, increments the grant use count; it replies `answer_ack{client_seq,key,status: consumed}` and then forwards. Any mismatch → `answer_ack{rejected,code}`, and the question stays open. A crash after the admission write follows the crash matrix (`delivery_unknown` until reconciled). A `cancel` body (`client_seq, session, task, grant_id, readback_id`) is bound the same way to a live task.
**Host restart and agent lifetime.** A restart starts a new epoch and invalidates local authority for every earlier question key (`authority_invalidated`); old-epoch answers and decisions are fenced and never forwarded. It does not assume the provider's questions or processes ended. Each session stays `reconciling` until its adapter observes provider state: a still-waiting provider question is re-issued under a new key with `supersedes: <old key>`; an observed close becomes `provider_closed`; anything unobservable becomes `provider_state_unknown` (spoken once, never auto-answered). No prompt, answer or cancel reaches a session until it is reconciled or the user acts on its unknown state. The host terminates only processes it spawned and recorded (pid + start time); it never kills unowned or `protected` processes, and an owned orphan is reported, not killed, unless the user cancels it with a bound `cancel`.
**Semantics.** Host→phone: replay within the ring, otherwise a snapshot — not unlimited at-least-once. Phone→host: at most one forward attempt per `(client_id, client_seq)`, bounded by host storage durability and reported through the crash-matrix statuses; no exactly-once claim, and no claim of non-execution without evidence. `ack` = admission, never execution success. A busy session returns `busy` (no queue, no scheduler). An unknown `type` or field is ignored, and a verb is offered only when its capability exists.

Errors and statuses: `unpaired`, `req_conflict`, `req_too_old` (= `evidence_expired`), `never_admitted`, `delivery_unknown`, `no_grant`, `grant_expired`, `grant_revoked`, `grant_exhausted`, `out_of_scope`, `stale_question`, `question_changed`, `authority_invalidated`, `expired`, `busy`, `protected`, `session_fenced`, `task_closed`, `auth_mismatch`, `auth_unverified`, `version`, `connector_exited`, `provider_limit`, `internal`.

## 5. Authority: provenance and binding (hands-free, explicitly authorized)

- **Voice is not identity.** A final STT result, confidence, "네/yes", a matching digest, key possession or absent contrary evidence never authorizes anything by itself.
- **Pairing** (setup, once per device and host) proves the device. **Session grant** (P; no scope, sensitive class, duration or limit is approved yet): at the start of a work session, with the screen on and a device credential or strong biometric, the user reviews `{grant_id, host_id, sessions/profiles, allowed action classes, max_uses, expires_at}`, and the phone signs those exact bytes with an auth-bound Keystore key (usable while screen-locked or under Smart Lock: U, V8). The host stores and validates the grant: expiry by the host clock, revocation state, and a use count incremented atomically inside the admission write of each authority-bearing command (allow, gated choice, cancel). Daily use afterwards is screen-free until the grant expires, is exhausted or revoked, or the session ends.
- **Revocation.** "권한 해제" (voice or screen) stops signing with that grant on this phone at once (local stop) and sends `revoke{grant_id}` as the next command. Only the host's durable `revoked` confirmation is spoken as "권한 해제 확인됨". Offline, the phone says "해제 요청됨, 호스트 확인 전": nothing new is signed from this phone, but commands the host already admitted stand. `revoke` needs no grant and no challenge.
- **Authority record.** An allowed command is recorded as "allowed under grant G via voice (or typed) readback", never as a fresh human approval at that moment. Audio or STT origin is an input attribute, not authority.
- **Per-command readback** (screen-free): exact readback (target and options verbatim, no path stemming) ending with a fresh two-digit challenge. The user answers verb + challenge ("승인 사십칠" / "allow forty-seven") as a final STT result inside the reply window with the earbud route active, and the phone signs the command with the §4 bindings, `grant_id` and `readback_id`. The challenge is correlation and attention only: 1 in 100 values collide, and a recording can repeat it. It is neither identity nor replay protection; replay protection comes from the signed, seq-bound, once-consumed command.

| Command (every row: paired-key signature over the exact body) | Provenance | Binding | Allowed scope | Grant use |
|---|---|---|---|---|
| approval allow | valid grant + complete readback + challenge | question key + `q_rev`/`q_digest` | action class inside the grant | consumes one |
| approval deny/defer | valid grant (expiry and revocation checked; use limit ignored) + complete readback | same | any open question in the grant's sessions | none |
| choice answer | as allow when the option carries a gated `action_class`, else as text | same + `option_id` | grant sessions | only when gated |
| text answer (voice or typed) | valid grant + echo-and-undo of the exact text | same | grant sessions; content only, no extra authority | none |
| prompt (voice or typed) | valid grant + echo-and-undo (2 s, P) | `client_seq`/`h`, session in grant | grant sessions | none |
| cancel | valid grant + readback of session/task + challenge | session/task/`started_by` | tasks this client started or sessions the grant marks cancelable; never `protected` | consumes one |
| revoke | paired device only | `grant_id` | this client's grants | none |

Typed prompts and answers, where core supports them, use exactly these rows with `input: typed`; typing on screen adds no authority (UI `7764ddb` §6.1, §12).

- **Sensitive actions and grant scope (C2; presented to the user separately, unanswered, nothing inferred):** e.g. deletion outside the project, git push/force, deploy/publish, secrets, network upload, system configuration. The candidate template (P, not approved) is read-only tools and project-scoped file edits. Running commands — including `npm test` or build scripts, which execute arbitrary project code — is not safe by command prefix: a delegated command allowance can exist only inside a verified sandbox with resource, network and filesystem limits (per connector, U) and otherwise stays out of scope. An out-of-scope request is spoken as "허가 범위 밖" and stays pending (deny or defer by voice); no desk workflow is substituted.
- **Connector without a question channel:** hands-free approvals for it are unavailable (blocker B3). This is never a reason to enable bypass or change the workflow.
- **Never bypass:** `bypassPermissions` and `--dangerously-skip-permissions` are not used for connector sessions (`claude-cli.ts:98-100`, `TermuxLauncher.kt:87`).
- **Stop ≠ cancel:** `멈춰/그만/stop` stop playback only. SSH-terminal mode gets no y/n/Enter mapping and no voice authority (F-f).
- **Raw terminal passthrough** (F-l) is an explicit, unresolved security capability: this contract does not authorize it, it is not a bypass, and it never carries voice authority. Until the security decision, 원문 renders read-only (UI `7764ddb` slice T).

## 6. Fidelity contract (highest-priority feature)

`summary` is built by the host adapter from machine events, and every field carries `src`:
- `turn{status: completed/failed/cancelled/limit/unknown, exit_code?, is_error?, src: cli_event/exit}` — the CLI turn ended; never task success.
- `claim{outcome: success/failure/partial/unknown, src: agent_reported}` — what the agent says.
- `checks[{kind: test/build/lint/deploy/other, status: passed/failed/not_run/unknown, src: agent_reported/observed_tool_exit/host_verified, ref}]` — `observed_tool_exit` means the host saw a command's exit code in the event stream; `host_verified` means the host itself ran a user-configured check (optional, off in v1).
- `changes{files[], out_of_project[], src: tool_events}`, `scope_change{flag, ref}`, `uncertainty[{ref, src: agent_reported}]`, `pending_questions[qid]`.
- `quote?{text, src: agent, parse: ok/failed}` — requested as a strict JSON block in the final assistant message only; text inside tool output or files is never parsed; a malformed block means no quote.
- `original_ref` (verbatim, ≤ 4 KiB, `truncated`).

**Rendering (phone, deterministic).** Mandatory fields are always spoken, in this order: pending questions → turn status → observed failures → out-of-project/scope changes → agent outcome claim (attributed "에이전트 보고") → uncertainty count → "자세히" when truncated. Exit 0 is spoken as "턴 완료", never "성공". Agent-reported checks are spoken as reported ("테스트: 에이전트 보고, 관측 없음"). The quote comes last, attributed ("에이전트 요약: …"). It is suppressed whenever the turn is not completed, a failure was observed, a scope flag or pending question exists, or the claim is not success; it stays available via "자세히". Unknown fields → "결과 확인 안 됨". This guarantees the presence and order of decision-critical fields, not the semantic truth of prose; no deterministic verification of arbitrary prose is promised.
**Counterexample fixtures** (each required; pass = every decision-critical field spoken and no contradicting success wording): FX1 exit 0, agent says "tests failed" · FX2 agent says "all tests pass", no test event · FX3 test exit 1 observed, agent claims success · FX4 summary JSON or `SPEECH:` text inside a tool result or file · FX5 edits outside the project or beyond the request · FX6 question pending at result time · FX7 truncated original · FX8 max-turns, provider limit or auth error · FX9 cancelled turn · FX10 deploy claim without a deploy event · FX11 malformed summary block · FX12 mixed Korean-English paths read verbatim.
**Cost.** The quote costs a few output tokens of the selected profile. The phone-side billed `TtsSummarizer` stays an explicit opt-in and is never used for questions or mandatory fields.

## 7. Lifecycle, activation and audio ownership

- **Single owner from the first production slice (S1).** The existing `ssh/SshForegroundService.kt` becomes the voice-session service and owns BridgeClient, SshSessionManager, SpeechManager, TtsManager, BargeInController, VoiceEngineManager, the ledger (§8) and the route. `MainViewModel` binds to it and exposes its state; `onCleared` only unbinds (today it destroys everything, F-h). One service instance per process; no second owner, no scheduler.
- **Start and stop.** Started from the visible activity when the user starts a voice session (D: a microphone FGS cannot be created from the background), typed `microphone|mediaPlayback` with `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `POST_NOTIFICATIONS`. It ends only on an explicit end (notification action or "세션 종료"). Ending never cancels host tasks, and the service does not start/stop per connection.
- **Fold and activity recreation:** activity and ViewModel rebind at will; service state and audio continue (V1).
- **No view dependency (F-k):** the service connects without any view. On a cold start with no prior size, SSH-terminal mode uses the `SshSessionManager` default 80×24 (`ssh/SshSessionManager.kt:90-91`); otherwise it uses the last reported size, and it resizes when a terminal view reports one (`resizePTY`, `:163-171`). The `pendingSshConnect` deferral is removed. The connector path (WebSocket, SSH port forward) needs no PTY at all. Moving the terminal off the home screen (ui1159) therefore cannot stall a connection (V1).
- **Process loss.** Host tasks continue. The service must not attempt a background microphone restart (today it is `START_STICKY`; P: not sticky). Recovery comes on the next foreground entry (activity or notification tap), or by media-button restart only if V9 shows that is permitted; then reconnect → snapshot → one line ("세션 복구, 대기 질문 N개"). The silent gap until recovery is blocker B2.
- **Screen-free activation.** (1) A reply window (6 s, P) after every spoken question or result, which works regardless of V7. (2) Headset play/pause through a `MediaSession` with `FLAG_HANDLES_MEDIA_BUTTONS` (D), only if V7 shows Voice Code receives it with the screen off after other audio apps played. (3) A headset/assistant voice-command intent (U, V7b). Without (2) or (3), a fresh prompt when nothing was just spoken has no screen-free trigger: blocker B2.
- **Interruption:** voice barge-in where V4 passes on the active route; the headset button where V7 passes; otherwise only inside reply windows. Stated, not assumed.
- **Route.** Listen windows call `setCommunicationDevice(<BT headset>)` and then `clearCommunicationDevice()` (D, the Android 13+ path). Whether `SpeechRecognizer` follows that device is U (V3); the fallback is `AudioRecord(VOICE_COMMUNICATION)` → `EXTRA_AUDIO_SOURCE` (D). Lost earbuds pause playback, with no speaker fallback. TTS gets `AudioAttributes` (assistant/speech) and holds a transient may-duck focus while items play (P).

## 8. Pending-question ledger vs playback

- **Ledger** (service-owned; the source of truth for questions): one entry per question key + content identity (§4): `pending → read_back → answer_sent → consumed / rejected / closed(reason)`. An entry leaves only via `question_closed` or a snapshot; a re-issued question links to its predecessor through `supersedes`. The ledger never triggers audio by itself.
- **Ledger bound:** at most 16 open entries on the phone (P), sent to the host as `caps.ledger_capacity`. The host keeps every provider question and pages: it sends open questions up to that capacity (priority, then age) and reports `held_count` for the rest; a slot freed by a close pages in the next one. Nothing is auto-answered, denied or dropped to make room, and counts are spoken honestly ("대기 질문 16개, 호스트 보류 24개").
- **Audio items:** `{item_id, ref: question key + content identity / result_id / notice, class, parts[], state: planned → queued → speaking → partial → completed / blocked / dropped}`. A question announcement has required parts (question, target/options, challenge). Only the TTS engine's completion report (`onDone`) for every required part within one attempt marks `completed`. Completed playback is not evidence that the user heard, understood or acknowledged anything (UI `7764ddb` §6.4).
- **Interruption:** barge-in, stop, route loss or an engine error makes the item `partial` and invalidates that attempt's challenge. A partial question is requeued once with a new challenge. A second interruption or error makes it `blocked` — still pending in the ledger, not answerable and not replayed — until the user says "질문 다시". Interrupted results and info go to the repeat buffer as `partial`.
- **Dedup:** a re-sent frame with the same question key + content identity, or the same `result_id`, never creates a second item. A new epoch always yields a new key.
- **Readback invalidation:** the readback and its challenge become invalid on a content change, a new question arriving mid-readback, any snapshot or reconnect, route loss, or 30 s without an answer (P). After a snapshot, the top-priority question gets one fresh bound readback automatically and the others get one on "질문 다시"; nothing repeats automatically for the same key, content identity and snapshot.
- **Audio bounds:** at most 8 queued audio items (P). Overflow collapses per class into one summary item — for questions "대기 질문 N개, '질문 다시'로 들어" (ledger entries remain). Results and info beyond the cap, or older than 120 s, move to the repeat buffer (last 20) and are counted. Each item is at most 2 sentences; "자세히" reads the original in sentence chunks.
- **Fixtures (specified, not run):** PX1 a second interruption of the same question → `blocked`, challenge invalid, no automatic replay. PX2 epoch E1 question `q1`/rev 1 fully played, host restart, epoch E2 reuses `q1`/rev 1 → new key, fresh readback required, no inherited completion or authority. PX3 40 open questions across sessions → 16 on the phone, `held_count` 24, one audio digest, nothing auto-answered, paging on close.
- **Semantic states for UI** (ui1159 consumes the service's state flows; no separate UI protocol): `session{idle/connecting/live/reconciling/recovering/ended}`, `listen{off/window/active}`, `playback{item_id,class,state,progress: measured/approximate/unavailable}`, `ledger[{key,q_rev,state,sensitivity_class}]`, `held_count`, `grant{valid_until,uses_left,revoke: none/requested/confirmed,scope_summary}`, `cmd_status[{client_seq,status,resend_safe}]`, `auth{declared,verified}`, per processing path (recognizer, summary, TTS, connector) `location`, `billing` and `consent` as separately verified fields (UI `7764ddb` §6.6, §9), and `blocked{reason}`.

## 9. STT/TTS engines: seam, baseline and comparison

- **Seam** (`VoiceEngineManager`, P): `SttEngine{warm(), start(source), partial/final, cancel(), id, version, location: on_device/lan/cloud}` and `TtsEngine{warm(), speak(text) → streamed chunks, cancel(), id, version, location}`. Every result and utterance reports the engine that actually ran; a selection is honored or reported unavailable, with no silent fallback (F-a).
- **Baseline:** Android `SpeechRecognizer` (the on-device variant when available, D) and Android TTS, measured on the device. The baseline is not declared best.
- **Comparison slices** (implementation phase; no download or execution now). On-device: the sherpa-onnx runtime (dependency for review) with Korean-capable candidates from the #1153/#1154 research, each only after its licence check — e.g. SenseVoice-Small int8, streaming Zipformer-ko only after licence clearance, Qwen3-ASR-0.6B int8 if its size fits. On-device TTS candidates need a maintained, permissive or explicitly accepted licence; the archived OpenRAIL-M Supertonic is a comparison point, never a default.
- **Remote candidates**, only if C1 includes a PC: Qwen3-ASR (vLLM streaming) and Qwen3-TTS CustomVoice through the connector host's authenticated WebSocket, streaming both ways, with a warm model and cancel on barge-in. No mandatory GPU or cloud. No engine is picked before device evidence: every candidate runs the same §10 fixtures, recording warm/cold start, streaming vs final-only, cancel latency, RAM and battery.
- **Cloud audio processing** (third-party recognition or synthesis, including a platform recognizer that is not on-device) → C3.

## 10. Performance acceptance (proposals; nothing measured)

| ID | Metric and method | Proposed budget |
|---|---|---|
| A1 | Intent/entity accuracy: 60 scripted synthetic utterances (Korean commands, Korean-English code-switch, paths, numbers, task ids), Buds2 Pro, quiet and street, per engine | verbs ≥ 97 %; entities ≥ 90 % raw, ≥ 99 % after echo/undo; wrong authority command executed = 0 (hard) |
| A2 | Silence: 10 min silence + 10 min TV/keyboard during listen windows | commands admitted = 0 (hard); false barge-ins ≤ 1 per 10 min |
| A3 | Fidelity: FX1–FX12 + 40 synthetic results, 2 raters | decision-critical fields present in 100 % of fixtures; contradicting success wording = 0 (hard); p95 speech ≤ 12 s |
| A4 | End-to-end latency, split: STT final → `ack`; `ack` → first agent event; host `question`/`result` emit → first audio at the earbud | each p50/p95 reported; proposal: emit → first audio p50 ≤ 0.8 s, p95 ≤ 1.5 s; STT final → `ack` p95 ≤ 1.0 s on LAN |
| A5 | Interruption: speech onset or button → silence | p95 ≤ 0.4 s on paths that pass V4/V7 |
| A6 | 60 min screen-off session, 30 prompts, per engine | battery ≤ 6 %/h; thermal below MODERATE; PSS growth ≤ 20 MB |

Logs carry ids, durations, route, API level and engine id — no audio, transcripts or credentials. Record device build, One UI and Buds firmware as observed; infer nothing from the device names.

## 11. Device validation matrix (Galaxy Z Fold7 + Galaxy Buds2 Pro; tester)

V1 fold/unfold and activity recreation during speech and listening (single owner, no duplicate audio; SSH connects on a cold start with no terminal view composed) · V2 30 min with the screen locked (questions, reply window, grant use) · V3 route changes (one bud out, case closed, reconnect, speaker) · V4 duplex/echo false-trigger rate per route · V5 barge-in latency with the ledger preserved · V6 30 s network drop and a host restart (snapshot, sessions reconcile before any command, no duplicate readout, old-epoch answer refused, crash statuses spoken as in §4) · V7 media-button ownership with the screen off after other audio apps played; V7b voice-command intent route · V8 grant key usable while locked / under Smart Lock · V9 process kill: recovery path and the length of the silent gap.

## 12. Security gates (red first, isolated; r1 gates kept, G8 added)

| Gate | Isolated reproduction (no real credentials, audio or personal devices) | Green |
|---|---|---|
| G1 bridge auth (F-d) | host temp dir; a stub `claude` first on `PATH` writes a marker; `node dist/index.js --port 18765 --project /tmp/vc`; a second process sends `user_input` → marker appears | unpaired → 4401, no marker; `Origin` → 4403; `/api/*` removed or 401 |
| G2 shared-storage hook (F-d) | static `grep -n voicecode-bridge-update termux/TermuxLauncher.kt`; dynamic only in an emulator Termux with a benign marker | hook and port-kill removed; launch command not logged (`:70,100`) |
| G3 SSH host key (F-e) | throwaway container sshd, test user; connect, rotate host key, reconnect → silent success | hard fail on mismatch; fingerprint spoken at first pin |
| G4 voice router (F-f) | JVM test: `멈춰` → Ctrl+C (0x03); `취소 버튼 추가해줘` → Ctrl+C; `네` → `y` + newline with no question | stop words stop playback only; no y/n without a live qid |
| G5 bare-shell reconnect (F-e) | container sshd, startup command `cat`; kill the session's sshd child → next utterance runs in bash | re-init on reconnect, or voice blocked until the CLI is confirmed |
| G6 logging (F-i) | emulator, fake key `sk-test-0000`, typed synthetic text → `adb logcat -d \| grep -c sk-test` > 0 | 0 matches for key and text |
| G7 question loss (F-g) | JVM test on the playback policy: question, then error → question gone | ledger entry survives until `question_closed`; audio item `completed` only on engine completion of every required part; PX1–PX3 |
| G8 replay/binding (F-c) | G1 harness sends the same `user_input` twice → marker count 2 | same seq + same `h` → stored ack; changed `h` → `req_conflict`; in-range unadmitted → `never_admitted`; below range → `evidence_expired` (may have run, never re-executed); old-epoch key, stale content identity, unsigned or wrong-key answer, expired/revoked/exhausted grant → rejected; CX1–CX4 |

Also required before hands-free authority ships: `dataExtractionRules` and Keystore-held secrets (`SessionStore.kt`); a builder-captured Claude stream-json fixture from a synthetic prompt (the F-b parser is unverified, and `--verbose` may be required, U); a Snyk code scan on every code slice before DONE.

## 13. Implementation slices and ownership

| Slice | Coder files (core-owned) | Dependency for review | Builder | Tester |
|---|---|---|---|---|
| S0 security | `ws-server.ts`, `index.ts`, `termux/TermuxLauncher.kt`, `ssh/SshSessionManager.kt`, `ssh/VoiceCommandRouter.kt`; log removals in `MainViewModel.kt`, `BridgeClient.kt`, `TtsManager.kt` | none | `npm run build`; `./gradlew assembleDebug` | G1–G6 |
| S1 service ownership (first production slice) | `ssh/SshForegroundService.kt` (owner + notification), `AndroidManifest.xml` (types, permissions), `MainViewModel.kt` (bind/expose only; remove the cold-start terminal-size deferral, F-k), `MainActivity.kt` (phase 1 only: service start/bind and removal of the `onPause`/`onResume` teardown) | none | device install | V1, V2, V9 |
| S2 protocol + pairing + grant | `protocol.ts`, `ws-server.ts` (admission, crash statuses, snapshot, ring, reconciliation fence), `index.ts` (client and grant store, retained range); `network/Protocol.kt`, `network/BridgeClient.kt`; `session/SessionStore.kt` (Keystore key, `client_seq`, pending commands, grant) | none | both builds | G8, CX1–CX4; admission/snapshot tests |
| S3 Claude adapter | `claude-cli.ts` (documented stream-json, resume by id, SIGINT, summary fields, env scrub, auth report); permission tool | official `@modelcontextprotocol/sdk` for `--permission-prompt-tool`, or the Claude Agent SDK permission callback — choose one in review; without it the question capability stays off | fixture capture (synthetic prompt, user consent) | FX1–FX12 |
| S4 ledger + fidelity + grammar | new `voice/SpeechLedger.kt`, new `voice/SpeechComposer.kt`, `voice/TtsManager.kt`, `voice/BargeInController.kt`, `voice/SpeechManager.kt`, `ssh/VoiceCommandRouter.kt`, wiring in `ssh/SshForegroundService.kt` | none | device install | G7, FX, A1–A5 |
| S5 engine seam + comparisons | `voice/VoiceEngineManager.kt`, one new file per candidate engine | sherpa-onnx AAR; remote engines via the host WebSocket | device | A1–A6 per engine |
| S6 remote host | `ssh/SshSessionManager.kt` (local port forward; sshj 0.38.0 API U) | none | host bridge from a pinned tag | V6 over SSH |
| S7 Codex app-server adapter | new `codex-app-server.ts` | none known (transport per fixture) | fixture | fixture replay |
| S8 Gemini/OpenCode adapters | new `gemini-cli.ts`, `opencode-cli.ts` | none | fixture | question capability off until proven |

- UI (ui1159) consumes the §8 states and calls service actions; core exclusively owns the service, manifest and notification wiring. File-disjoint slices can run in parallel; slices sharing a file serialize: `MainViewModel.kt` (S0, S1), `SshForegroundService.kt` (S1, S4, S5), `ws-server.ts` (S0, S2), `SshSessionManager.kt` (S0, S6), `VoiceCommandRouter.kt` (S0, S4), and `MainActivity.kt` (core S1 phase 1 first, then UI slice D as screen host; never concurrently).
- Runners: Android `./gradlew test` (JUnit4 + coroutines-test, `build.gradle.kts:74-75`); bridge `"test": "npm run build && node --test test/"` (built-in runner); device results go to a CSV. Per slice, coder ≠ builder ≠ tester.

## 14. Package, install, update, rollback (kept from r1)

- **APK:** today `versionCode 1` with no release signing (`build.gradle.kts:15-27`). Per release: bump the versionCode, run `apksigner verify --print-certs`, and record the SHA-256 and the `dumpsys package` versionCode before and after. Keep the previous signed APK. A downgrade may be refused, and uninstall+install loses DataStore — say so. DataStore stays readable by the previous version.
- **Bridge:** a pinned tag + `npm ci` instead of `curl | bash` from `main` or `git pull` (`scripts/termux-setup.sh:3,67-72`). Rollback = the previous tag. `welcome.host_version` + `v` reject incompatible pairs. The `/sdcard` update path is removed.
- **Evidence bundle:** app and bridge SHAs, artifact hashes, one `welcome` frame (versions and capabilities only), matrix CSV.

## 15. Remaining human choices and true blockers

**Choices** (material; nothing is inferred from silence or from these questions having been asked):
- **C1** Host placement: phone-only (Termux) or also an optional user PC over SSH — unanswered. It decides the remote engine candidates and whether Claude Code must run on Termux (U).
- **C2** Initial grant scope: sensitive action classes, duration and use limit — presented to the user separately; no answer or approval yet. The §5 template is a candidate only.
- **C3** External-cloud audio consent — presented to the user separately; no answer, approval or cost authorization yet. Until answered, no external-cloud audio path is enabled; the platform recognizer runs only in its on-device mode, and a recognizer whose location cannot be verified is reported as unverified and needs that consent.

**Settled** (not asked again): API and subscription both supported per profile; concise speech; setup on screen vs screen-free daily use; no automatic speaker or paid fallback; no bypass.
**Blockers** (not user choices):
- **B1** Provider terms for subscription-driven programmatic use need corroboration (Claude support article 15036540 vs the SDK overview wording; per provider for the others). Blocks enabling subscription profiles by default.
- **B2** Screen-free activation and recovery: V7/V7b (media button, voice-command intent) and V9 (process loss) are unmeasured. Until they pass, a fresh prompt needs the reply window after a spoken item.
- **B3** Question channels and adapter receipts: Codex app-server method names, a per-connector receipt/reconciliation for the crash matrix, and the Claude permission-tool timeout vs `expires_at` need fixtures; Gemini and OpenCode have no documented channel. A connector without a channel has no hands-free approvals, and without a receipt every post-admission crash stays `delivery_unknown`.
- **B4** Per-connector auth verification: which report field proves subscription vs API key (fixture). Unknown → the subscription profile is refused.
- **B5** Device gates: V3 recognizer routing, V4 echo, V8 grant key usability.
- **B6** Dependency review: MCP SDK vs Agent SDK; sherpa-onnx.

## 16. Self-review and sources

- S rows were re-read at `5d98d60`: the `onCleared`, service and terminal-size lines for r2, and the raw-terminal lines (F-l) for r3. Dirty state unchanged. r3 reuses the UI contract `7764ddb` invariants and adds no external research; fixtures CX1–CX4 and PX1–PX3 are specified, not run.
- No claim of measured performance, exactly-once delivery, verified semantic fidelity, or success from an ack, exit code or idle status. Genuine unknowns are marked U with their smallest verification.
- Snyk: N/A (documentation only).
- D sources (retrieved 2026-09-11 for r1): code.claude.com/docs/en/cli-reference · learn.chatgpt.com/docs/non-interactive-mode · github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md · opencode.ai/docs/cli · developer.android.com fgs/service-types, speech/SpeechRecognizer, ble-audio/audio-manager, media/legacy/media-buttons · AOSP `RecognizerIntent.java`.
- The reviewer-cited learn.chatgpt.com/docs/app-server was not re-fetched in r2 (no new research authorized); Codex app-server details stay U until the S7 fixture.
