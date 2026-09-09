# #1148 — Prompt-aware CLI/model/EFFORT production contract (additive to #1133)

Effort becomes the third member of the dispatch decision tuple: selected per prompt, validated against per-CLI capability evidence, and *applied* through the child's environment. #1133 (`docs/specs/2026-09-08-model-router-production.md`) remains the contract for CLI+model, eligibility, capacity and ledger; this adds only what effort needs, and names where the two contradict. No new service, framework, dependency or file.

## 0. Measurement basis

Read-only, 2026-09-09T12:52Z, worktree `~/.aigentry/worktrees/ar1148`, branch `docs/1148-adaptive-routing` at `a3c97c2` — **identical to `main` `a3c97c2`**, so every blob below is main's. Blob SHAs (12): `src/dispatch/cli.ts` c29fe73f9eaf · `bin/boot-prepare.mjs` 5c1136610de4 · `bin/model-router.mjs` 3737b92ddfd7 · `docs/model-profiles/model-routing-profile.md` a937791c86e5 · `boot-adapter/{claude,codex,grok,gemini}.ts` b3894e18f0a4 / 0f9f25685167 / 26b07de96fe4 / 926321f8ea26 · `src/session/open-session/cli.ts` 93af64815346 · `tests/dispatch/T141-model-launcher-flags.test.ts` 53a2150452bd.

**Currentness (r2, 2026-09-09).** `main` has since advanced to `4ff94cd` (`992cd6c` task queue, `84db0f1`+`4ff94cd` the #1136 spec). **Every blob above is byte-identical on `4ff94cd`** — the three commits touch only docs — so the measurement below is current against main, not merely against `a3c97c2`.

**Not executed:** no build, test, `--help`/`--version`, live model or classifier call, auth or credential read, config write, or subagent. Every version and effort-vocabulary fact below is quoted from repository text, not re-probed. **This is a source reading, not an installed-capability catalogue**: what the repository records about a CLI is not what the installed binary, at its installed version, with a given model, actually supports (§1.2).

### 0.1 Recount — six writers, and the production entrypoint is not the obvious one

When `boot-prepare.mjs` succeeds, `spawnWorkspace` calls `writeWorkerLauncher(sid, o.cli, bootSpawnCli, "", …)` with an **empty flag string** (`cli.ts:1000`) — so **`defaultCliFlags` is dead on every role dispatch** and runs only on the legacy/no-role fallback arm.

| # | Writer | Model from | Effort from | Reached when |
|---|---|---|---|---|
| W1 | `cli.ts:126-141` `defaultCliFlags` | `childEnv.*_MODEL` | **`env.*_EFFORT`** | legacy arm only |
| W2 | `boot-prepare.mjs:671-676` (claude) | `process.env.*_MODEL` | `AIGENTRY_CLAUDE_EFFORT` | every claude role dispatch |
| W3 | `boot-adapter/codex.ts:39-48` | `AIGENTRY_CODEX_MODEL` | `AIGENTRY_CODEX_EFFORT` (dflt `high`) | every codex role dispatch |
| W4 | `boot-adapter/grok.ts:10-11` | `AIGENTRY_GROK_MODEL` | `AIGENTRY_GROK_EFFORT` (opt-in) | every grok role dispatch |
| W5 | `boot-adapter/gemini.ts:61-63` (agy) | `AIGENTRY_GEMINI_MODEL` | `AIGENTRY_GEMINI_EFFORT` (opt-in) | every agy role dispatch |
| W6 | `open-session/cli.ts:337-339` | `AIGENTRY_CLAUDE_MODEL` | `AIGENTRY_CLAUDE_EFFORT` | manual open-session, **not** dispatch |

`boot-adapter/claude.ts:22` carries neither — claude's are appended by W2. Compiled entrypoints: `bin/dispatch.sh` → `dist/src/dispatch/cli.js`; `boot-prepare.mjs:537-548` refuses to run without `dist/src/session/boot-adapter/index.js`. `bin/init/manifest.mjs:24,44,72` + `package.json:35` already ship router, boot-prepare and profile — **a new profile section needs no packaging change; a new file would.**

### 0.2 The gap

`resolveRoute` (`cli.ts:417-449`) yields `{cli, model, label, decided_by, reason}`; `spawnWorkspace` (`cli.ts:952-953`) propagates **only the model**: `spawnEnv = {AIGENTRY_<CLI>_MODEL: route.model}`. That object is both the extra env of the boot-prepare child (`captureOut`, `:66`) and the export block of the guard launcher (`:188`) — so model reaches every writer and **effort reaches none**. Effort is read from the *dispatching process's* ambient env at W1–W6, identical for every worker in a wave. That is #1084's static per-operator knob (`AGENTS.md:147`: "자식 세션에만 적용" — child-scoped, not task-scoped), not adaptation. Today a logger summarising three lines and an architect designing a subsystem both get claude `xhigh` / codex `high`. #1084's own defect measured the cost side: three `gpt-6-astra` workers at `xhigh` drained the codex 5-hour window in ~10 min (2026-09-05).

### 0.3 Effort evidence in-repo, and its holes

| CLI | Surface | Vocabulary | Provenance |
|---|---|---|---|
| claude | `--effort <tier>` | `xhigh` used; full set **unknown** | W2/W6 usage only |
| codex | `-c model_reasoning_effort=` (no flag) | `low medium high xhigh max ultra`, CLI dflt `low` | ADR `2026-09-05-model-routing.md:159-161`, measured on **0.153.4** |
| grok | `--reasoning-effort` | flag exists; values **unmeasured** | profile `:40` (grok 0.2.93); ADR:163 |
| agy | `--effort` | flag exists; values **unmeasured** | profile `:47` (agy 1.1.27) |
| gemini-cli | — | **no effort flag** | ADR:162 |

One CLI has a measured tier list, four do not. There is **no shared scale** (codex has six tiers; claude's set is unrecorded) and **no cost or token figure per tier anywhere in this repository** — so this spec never converts a tier to a price, a saving, or a latency number.

## 1. Contract

### 1.1 Tuple — four additive envelope fields (#1133 §7.1 shape kept)

```jsonc
{"cli":"codex","model":"gpt-6-astra","label":"gpt-6-astra","decided_by":"table","reason":"…",
 "effort":"medium",              // validated token, or null = APPLY NO OVERRIDE (§1.1.1)
 "effort_by":"table|structured|llm|operator|existing",
 "effort_status":"selected|inherited|not-applicable|unknown|refused",   // §1.1.1
 "effort_evidence":{"kind":"verified|help-only|unknown","source":"profile:effort_support[…]",
                    "binary":"codex","binary_version":"0.153.4","model":"gpt-6-astra",
                    "measured_at":"2026-09-05","verified_by":"help|provider-doc|both"},
 "configured_argv":"-c model_reasoning_effort=medium",  // what dispatch WROTE; not proof of anything
 "policy_rev":"<profile_version>:<effort_policy digest>"}
```

#### 1.1.1 Five states — `null` does **not** mean "no flag"

**Correction (r2).** W2 (`boot-prepare.mjs:675`) and W3 (`codex.ts:44`) append effort **unconditionally**, from `process.env.AIGENTRY_CLAUDE_EFFORT || "xhigh"` and `AIGENTRY_CODEX_EFFORT || "high"`. Omitting the key from `spawnEnv` therefore does **not** produce "no flag" and does **not** produce "the CLI's own default" — it produces the **hardcoded aigentry default**, `xhigh` / `high`. Only W4/W5 (grok/agy, #1084 opt-in) genuinely emit nothing.

| `effort_status` | Meaning | Launcher bytes |
|---|---|---|
| `selected` | a supported override was chosen and written | changed, `configured_argv` records it |
| `inherited` | no override applied — **legacy effective policy retained verbatim** | byte-identical to today (`xhigh`/`high`/absent, per writer) |
| `not-applicable` | resolved binary has no effort surface (gemini-cli, §1.2) | unchanged; never reported as an override |
| `unknown` | capability unmeasured for this tuple ⇒ **adaptation paused** | unchanged; never a fabricated token |
| `refused` | explicit caller input unsupported for this tuple ⇒ exit 4 | nothing spawned |

`inherited` is the default and the safe state: the mechanism for it is "do not add the key to `spawnEnv`", but the *contract* is **preserve legacy bytes and values until a supported override is applied**, which is what the tests assert. **Precedence, explicit vs inherited:** `--effort-tier` (explicit caller) > `AIGENTRY_<CLI>_EFFORT` present in the dispatching env (explicit operator) > selected override (§1.3) > the writer's hardcoded literal (inherited). The first two are *explicit input* and can never be silently dropped: unsupported ⇒ `refused`, never clamped, never ignored. **`configured` ≠ applied:** `configured_argv` states what dispatch wrote; whether the provider applied that tier to that model is not observable from argv and is never claimed. Every status is evidence-qualified to the configuration layer only.

### 1.2 Capability data — keyed by binary + version + model, not CLI kind

**Correction (r2).** CLI kind is the wrong key. Kind `gemini` resolves at runtime to **two different binaries** — `geminiBinary()` (`gemini.ts:16-21`) returns `agy` when one is on `PATH` (or `AIGENTRY_GEMINI_BINARY` forces it), else `gemini` — with different default models (`gemini-3.8-flash-high` vs `gemini-2.5-flash`) and different effort surfaces (`--effort` vs **none at all**). A kind-keyed table would claim an effort surface for a binary that has none. Effort support is a property of the **(binary, installed version, model)** tuple.

```yaml
profile_version: 4
effort_support:      # one line per SUPPORTED tuple; ordering of `band` IS the ordering
  - {binary: codex, version_min: "0.153.4", model: "gpt-6-astra", band: "low medium high xhigh max ultra", verified_by: help, measured_at: "2026-09-05"}
effort_policy:       # role -> {min, max} band position, per §1.3; applies only to supported tuples
  architect: "high xhigh"
  logger:    "low medium"
```

* **A tuple absent from `effort_support` is `unknown`** → `effort_status: unknown` → **adaptation paused, legacy retained** (§1.1.1). Never a fabricated token.
* **`verified_by: help` is not support.** That the installed parser accepts a token proves the *flag* parses, not that the *provider* honours that tier for that *model*. Only `verified_by: both` (installed help/`debug models` **and** the provider's own primary documentation) enables adaptation; `help` alone is recorded and stays `unknown` until doc-verified.
* **`gemini` (gemini-cli) is `not-applicable`** by evidence — no effort flag at all (`gemini.ts:65-83`, ADR:162); `agy` is a separate row, `unknown` until measured. **stale** — `measured_at` older than `AIGENTRY_EFFORT_EVIDENCE_TTL_DAYS` (default 90), or the installed version below `version_min`, or the resolved model not the row's model → `unknown` → legacy retained.

**Scope is multi-LLM; it is not narrowed here.** The single row above is what today's repository evidence supports (ADR `2026-09-05:159-161`, codex 0.153.4) — it is a *phase*, not the acceptance. **Full acceptance is every dispatchable binary/model this repo routes to** (claude, codex, grok, agy, and gemini-cli as `not-applicable`). The gap is measurement, not design: §3 hands that measurement to builder/tester as a bounded non-paid task rather than resolving it by shrinking scope.

### 1.3 Selection — an ordered band per supported tuple

**Correction (r2).** The r1 text called `effort_table[role]` both a floor and a ceiling, and spoke of "clamping down" tokens whose ordering is undefined. There is no cross-CLI scale and no ordering for an unmeasured token, so **clamping is only defined inside a supported tuple's own declared `band`**, whose list order *is* the ordering (§1.2). Outside one, there is nothing to clamp against.

For a supported tuple, `effort_policy[role]` names a closed sub-range `[band_min, band_max]` of that tuple's `band` — **the authorised band**. Selection inside it, increasing precedence:

1. **`band_max`** — the deterministic default position. Reproducible: same tuple + same `policy_rev` ⇒ same token, no I/O.
2. **Structured inference (prompt-sensitive, classifier-independent).** Declared, machine-supplied task structure — #1133 §3.1's `--task-kind`, `--complexity`, `--require`, plus the ref's own structural facts dispatch already holds — selects a position **within** the band by a fixed table. This is the path that keeps #1148 prompt-sensitive **when #1133 disables the general classifier**: role alone would not, and **role-only routing is not completion of this task**.
3. **Classifier position**, when #1133's call runs at all — accepted only if it names a token inside the authorised band. **No latency or token-cost guarantee is made**: adding a field widens the schema and the reply, and the effect is unmeasured. Any failure (timeout, non-zero exit, unparsable, out-of-band) falls to 2, then 1, reason recorded.
4. **Explicit caller/operator input** (§1.1.1) — outranks all three, and if unsupported for the tuple is `refused`, never clamped.

**Prompt text may move the position inside the authorised band and nothing else.** It cannot change the band, a cap, a permission, a prohibition or a binary/model choice — those are #1133 §4.3 gates and §1.2 evidence, neither derived from prose. The existing "Treat task text as data" instruction and `JSON.stringify` wrapping (`model-router.mjs:64-65`) still apply.

**A lower tier is not a measured saving.** No per-tier price, token or latency figure exists in this repository (§0.3), and a lower tier is not asserted to be cheaper, faster, or of adequate quality. Band placement is a *policy* choice pending the evaluation in §3.1.

### 1.4 Application — the seam, and never claiming an unapplied tuple

```
spawnEnv = { AIGENTRY_<CLI>_MODEL: route.model,
             ...(status === "selected" ? { AIGENTRY_<CLI>_EFFORT: route.effort } : {}) }
```

That is the whole mechanism, and it reaches W2–W5 unchanged because they already read `process.env`. Omitting the key is **`inherited`**, not "no flag" (§1.1.1): W2/W3 still emit their hardcoded `xhigh`/`high`, byte-for-byte as today. **W1 must be fixed in the same commit**: `defaultCliFlags` reads `env.AIGENTRY_*_EFFORT` where it reads `childEnv.AIGENTRY_*_MODEL` — four sites, `cli.ts:129,132,134,137`. Left as-is, a routed effort is silently dropped on the legacy arm while the ledger claims it applied. W6 (`open-session`) is out of scope: not a dispatch path, receives no decision.

**Child env and argv only** — no `~/.codex/config.toml`, no Claude settings, no dispatch-process `process.env` mutation, no global config. Codex's tier still travels as `-c model_reasoning_effort=` (no flag exists). Argv safety is layered: the token is validated against the tuple's `band` (§1.2) *before* becoming an env value, so no unvalidated string ever reaches argv; `shellQuote` (`cli.ts:117`, boot-prepare `flagsLine`) stays as defence in depth — T141 already pins `AIGENTRY_CODEX_EFFORT="high; touch SHOULD-NOT-EXECUTE"`.

**Recorded** in the queue-note stamp (`cli.ts:690-692`) and telemetry: `effort=<token>/<by>/<status>` using §1.1.1's five states plus `session-fixed` for `--target`. `selected` is written only when the token is present in the **written launcher file**; an environment variable being set is never sufficient, and neither is the launcher sufficient to claim the provider applied it (§1.1.1).

### 1.5 `--target` and re-evaluation boundaries

`--target` reuses a running worker whose CLI/model/effort were fixed at spawn; **no env change alters a live process's reasoning tier.** This repeats the binding 2026-09-05 #1083 precedent for the model ("`--target` cannot change an existing worker CLI/model … approved reading (2) over (1) — (1) would ledger a model never applied"). So `--target` ⇒ `effort_by: "existing"`, `effort: null`, `application_status: "session-fixed"`; `--target` **with** `--effort-tier` is a usage error (exit 4) — not a silent no-op, not a pretended switch.

**The only supported re-evaluation boundary is a new dispatch**, and that boundary is **#1136's**, reused — this spec defines no second task selector. No in-session switching is designed, because no mechanism for it has been measured.

**Correction (r2): the registry does not prevent a concurrent worker for the same task.** `dedup_key = sha256(sid + "\0" + ref_hash)` (`dispatch-registry.py:305-306`) carries no task identity, and the order in `main()` is `taskGateCheck` (`cli.ts:1033`) → **`spawnWorkspace` (`:1075`)** → `waitForReady` (`:1095`) → `beginDelivery` (`:1102`) → `inject` (`:1126`): **the worker is spawned before any delivery record exists.** Two dispatches of one task under different sids or refs are neither deduplicated nor serialised.

Escalation therefore cannot live in queue prose plus `policy_rev`. It requires a **durable structured claim** — `{task_id, attempt_n, previous_tuple, claimed_at}` — written at #1136's dispatch boundary and keyed by task identity, with a **bounded attempt count that a policy revision does not reset** (a revision changes the band, never the budget). Until that claim exists, escalation is **not** part of this slice; §1.5's contribution is the boundary definition and the refusal, not a retry engine. No online learning, no counter-driven auto-tuning, no claimed saving.

### 1.6 Capacity — unchanged

#1133 §8's count-and-claim and the live `AIGENTRY_CLI_CAP_<CLI>` caps (`cli.ts:485-506`) gate the tuple exactly as they gate the CLI today. Effort never adds to, weights or bypasses a count, and never justifies an override. Per-tier quota burn is **unknown**, so no weighted counter is proposed. On cap fallback the effort is re-validated against the **new** binary/model tuple's own row — a tier valid for codex is not assumed valid for claude, and an unmatched fallback is `inherited`, not carried over.

## 2. Contradictions with #1133, stated

1. **LLM role and prose weight.** #1133 §5-6 demotes the classifier to a tie-break, default-off in shadow; today it runs on every `--cli auto` dispatch. §1.3 survives either, because the *required* path is deterministic structured inference (source 2) and the classifier is source 3 — this is why role-only routing would not have satisfied #1148. #1133 §3.1's "prose is advisory, never load-bearing" is kept exactly: prose moves the position **inside** an authorised band and changes no band, cap, gate or binary/model choice. Prompt-**aware**, never prompt-**authoritative**.
3. **Parser coupling.** `effort_support`, `effort_policy` and `profile_version` all need #1133 §4.1's F2 whitelist — `model-router.mjs:47` throws on any unrecognised top-level key, and landing the profile edit alone routes **every** dispatch to emergency Opus (#1133 §1.12). Parser and profile are one commit, always.
4. **Nothing of #1133 approved here.** Q2–Q6 (cap counting, confidence floor, ref budget, production fail-open, `--override-cap`) stay open and untouched. This spec changes no cap, no default model and no existing effort default: on first commit every CLI but codex is `unknown`.

## 3. First slice, ownership, remainder

**One file per worker** (r2 correction). Files below are assigned individually; related files may still integrate as **one commit/PR**, but a worker is never handed three paths. **Test paths are descriptive, not reserved** — the r1 `T151…T155` block is withdrawn; the orchestrator reserves the number or a block at branch time. `tests/**/*.test.ts` compile to `dist/tests` and are auto-collected by `scripts/run-tests.mjs:10-24`, so no orphan-file risk.

| ID | File | Change | Owner |
|---|---|---|---|
| **E0** | `tests/dispatch/<reserved>-effort-configured-tuple.test.ts` | **reproduction** (§3.0) | tester-1 |
| **E1** | `bin/model-router.mjs` | parser whitelist (shared with #1133 F2); `effort_support`/`effort_policy`; §1.2 evidence gating; §1.3 band selection; §1.1 envelope | coder-A |
| **E2** | `docs/model-profiles/model-routing-profile.md` | §1.2 rows — **integrates in E1's PR** | coder-A2 |
| **E3** | `tests/dispatch/fixtures/model-routing-profile.md` | fixture gains the shape — **integrates in E1's PR** | tester-1 |
| **E4** | `src/dispatch/cli.ts` | §1.1.1 states + precedence; `spawnEnv` on `selected`; **`env.`→`childEnv.` ×4 at :129,132,134,137**; `--effort-tier`; `--target` refusal; note stamp | coder-B |
| **E5** | `src/dispatch/usage.ts` | `--effort-tier`, exit codes, the `--target` refusal — **integrates in E4's PR** | coder-B2 |
| **E6** | `tests/dispatch/<reserved>-effort-acceptance.test.ts` | acceptance §3.1 | tester-2 |
| **E7** | *(no repo file)* | **capability measurement** (§3.2) — its output is the E2 row set | builder+tester |

**Edges:** `E0 → {E1,E4}` (red first) · `E1 → {E2,E3}` same PR · `E4 → E5` same PR · `E1 ⇢ E4` contract only · `E7 → E2` (a row may not be written before it is measured). **Serialised:** `src/dispatch/cli.ts` (E4) against #1133 F3b and #1136 — whichever lands second rebases; `bin/model-router.mjs` (E1) against #1133 F2. **Parallel-safe:** E0, E6, E7 against E1/E4. **Builder:** E4 is TypeScript — `tsc -p .` before any guard and again before merge (`npm test` refuses a stale `dist/`). Snyk on E1 and E4 before coder DONE.

### 3.0 The reproduction, stated as the desired behaviour

**Correction (r2): the r1 reproduction asserted the bug and would have passed on baseline.** A red test must assert what is *wanted*.

**Assertion:** two dispatches whose *declared* task structure differs (e.g. `--role logger` and `--role architect`, same CLI, same fixture profile, same everything else) must write **different `model_reasoning_effort=` values into their launcher files**. On `4ff94cd` both launchers contain the identical literal `model_reasoning_effort=high` (`codex.ts:44`, no per-dispatch input exists), so the assertion **fails on the named production behaviour** — not on missing fixtures, not on a setup error. A second assertion pins the inverse guarantee: with no supported override, the launcher bytes are **identical to baseline** (`inherited`, §1.1.1), so the fix cannot be mistaken for "always write something".

**First single-file handoffs, both parallel-safe, then stop:**
* **tester-1 → E0**, one new test file, extending the existing `fixture()` harness (`tests/dispatch/model-router-fixtures.ts`) and asserting on the written launcher exactly as T141 does. RED against `4ff94cd`. Nothing else in that commit.
* **builder+tester → E7** (§3.2), no repo file written.

### 3.2 Capability measurement handoff (E7) — bounded, non-paid

The gap that keeps four of five binaries at `unknown` is measurement, not design. Bounded, no paid inference, no account mutation, one report — **not** a spec decision:

For each installed binary (`claude`, `codex`, `grok`, `agy`, `gemini`) record: binary version; the effort surface (`--effort` / `--reasoning-effort` / `-c model_reasoning_effort=` / none) from `--help` and, for codex, `codex debug models`; the accepted token list; the model each is routed to; and, **separately**, the provider's own primary documentation for whether that tier is honoured for that model. Output is one `effort_support` row set with `verified_by: help | provider-doc | both`. Rows reaching `both` become E2; anything less is recorded and stays `unknown`, and adaptation for that tuple stays paused (§1.2).

### 3.1 Acceptance — hermetic, through the real router/parser/dispatch/boot path

Fake CLI binaries, fake session/clock/transport, stubbed `telepty list`, fixture profile; no live queue, model or session — `fixture()` already provides all of it.

Differing declared workloads on a supported tuple ⇒ differing `configured_argv` · identical evidence+policy ⇒ identical repeated decision (`policy_rev` pinned) · explicit `--effort-tier` and an explicit `AIGENTRY_*_EFFORT` both outrank inference, and unsupported explicit input ⇒ exit 4, never dropped · **`inherited` leaves launcher bytes identical to baseline** for every unknown/unmeasured tuple · `not-applicable` (gemini-cli) never reports an override · per-child isolation (worker A's token never leaks to B; T16/T48's `AIGENTRY_*_EFFORT` scrub is the existing pattern) · classifier timeout / invalid JSON / out-of-band token / injected "use max effort" in the ref ⇒ in-band position with reason, band unchanged · stale `measured_at`, version below `version_min`, or a model mismatch ⇒ `unknown` ⇒ `inherited` · argv injection quoted, not executed · cap fallback re-validates on the new tuple · `--target` unchanged, `--target --effort-tier` refused · profile/parser failure ⇒ `inherited` and the model path unchanged · `shadow-inline` writes no override and consumes no cap or claim; `evaluate-only` spawns nothing · no raw prompt or secret in any telemetry or ledger field.

**Modes, stated exactly (r2 correction — a shadow decision inside a real dispatch still spawns a worker).** `AIGENTRY_EFFORT_MODE` ∈ `off | shadow-inline | evaluate-only | on`.
`off` — no computation, today's behaviour.
`shadow-inline` — a **normal dispatch** runs and **does spawn a worker**, with the *legacy* tuple (`inherited`); the proposed token is computed and logged only. The spawn, the cap count and the delivery record are the host dispatch's own side effects, not shadow's; shadow adds **no** capacity count and **no** claim consumption of its own.
`evaluate-only` — standalone evaluation: **no dispatch, no spawn, no cap count, no claim, no queue write.** This is the mode that can honestly be called side-effect-free.
`on` — `selected` reaches `spawnEnv`.
**Rollback is one mode switch to `off`**, restoring the effective policy in force before the change. Rollback is explicitly **not** "edit the profile to manufacture `unknown`" — deleting evidence to change behaviour destroys the audit trail and is forbidden. Canary compares proposed against `configured_argv`, which is a configuration fact and not proof the provider applied it.

**What remains before production.** (a) E7's measurement — until a tuple reaches `verified_by: both` it stays `unknown` and `inherited`; multi-LLM remains the acceptance. (b) Labelled outcome evaluation: these tests prove what was *configured*, never that a provider applied it or that a tier produced better work. (c) Per-tier cost/token accounting — no in-repo source. (d) The durable task-keyed claim (§1.5) before any escalation. (e) Clean-`HOME` smoke on the packaged tree (no manifest change needed, §0.1). **None of (a)–(e) ships in this slice, and the slice must not be reported as production adaptation.**

## 4. The one user-owned decision

r1's P2 ("codex-only or block?") was a false choice: lack of measurement is an E7 handoff, not a scope decision, and the task stays multi-LLM. What remains is genuinely the user's, and is asked once, **after** the technical defaults above are corrected and with **no live change in this phase**:

**Within an approved, tested band for a supported tuple, should effort be quality-first or balanced?**
* **Quality-first** — `band_max` always; structured inference and the classifier may not lower it. Effort adaptation then buys explainability and an audit trail, not spend reduction.
* **Balanced** — structured inference may move the position down inside the authorised band for cheap, well-specified work.

And, separately: **at canary, may the effective default change at all?** Today's effective defaults are claude `xhigh` and codex `high`, both hardcoded (`boot-prepare.mjs:672`, `codex.ts:44`). `inherited` preserves them exactly; any band whose `band_max` differs from them changes live behaviour the first time a tuple becomes supported.

**Costs and quality are explicitly unmeasured** (§0.3, §1.3): no per-tier price, token or latency figure exists in this repository, and no claim is made that a lower tier is cheaper or that a higher one is better. The evaluation that would answer it is §3.1's, and it has not run. Until this is answered, the conservative default stands: **quality-first, `inherited` everywhere, no live default changed.**
