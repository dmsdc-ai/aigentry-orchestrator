# Exec-Mode Experiment Harness — BUILD SPEC (Phase 0)

> **Status**: Phase 0 (spec submission only). Awaiting `[IMPLEMENT APPROVED]` from orchestrator before any code lands.
> **Author**: `E-harness-builder` session
> **Target spec**: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` (v3-max.1)
> **Spec lock**: git tag `exec-mode-v3-max-preregistered-20260420` (commit `25bd0a9`). No deviations without orchestrator approval.
> **Analysis plan lock**: `docs/superpowers/analysis-plan/2026-04-20-exec-mode-analysis.md`
> **Report path expected by inject**: `docs/plans/2026-04-20-exec-mode-harness-buildplan.md` — this document is authored under conventional `docs/superpowers/plans/` per prior 4 plan precedents (`2026-04-19-*.md`). Orchestrator should treat this path as authoritative.

---

## 0. Evidence of spec read

Three concrete invariants extracted from the locked spec — these drive the hardest parts of the design. Each is cited by file:line so the reviewer can verify I did not paraphrase away a constraint.

1. **D/S briefing must be raw turn-delimited transcript, not a summary** — spec §4.1 line 76:
   > *"D/S의 briefing artifact는 summary 금지, 원시 turn-delimited transcript. P-fresh의 replay도 동일 turn 구조. 구조적 차이 최소화."*
   Harness must *not* call any summarizer on `setup_history.md` before inject. The fixture's on-disk file IS the canonical payload; harness reads it verbatim and concatenates `=== PRIOR CONVERSATION HISTORY ===` headers per `fixtures/exec-mode-experiment/canonical_briefing.md` §Format.

2. **Subagent cost accounting must recurse into nested spawns** — spec §5.1 line 206:
   > *"Subagent: `subagents/agent-*.jsonl` 별도 파싱. Nested subagent spawn 감지 시 recursive roll-up (Medium 3 fix)."*
   Cost parser must walk `~/.claude/projects/{proj}/subagents/**` recursively and sum usage buckets into the parent trial's `cost_marginal_$`, not just the top-level session JSONL.

3. **Probe questions must never appear in Stage 1** — spec §5.4 line 286, §7.1 line 357-358:
   > *"중요: probe 질문은 Stage 2 isolated 세션에만 존재. Stage 1 (production) session에는 절대 노출 안 됨. 모든 모드 동일 평가 조건."*
   The harness is structurally split: the Stage 1 executor (`execute_task_<mode>()`) and the Stage 2 replayer (`run_probe_session()`) share no file descriptors and the probe text lives only in `post_probes.md`, read at Stage 2 time. Same rule applies to S-mode: one Task-tool dispatch (task only), then one isolated `claude --print` call (transcript + probes).

These three together imply the module boundary between *executor*, *probe-replayer*, and *cost-parser* — they cannot be collapsed.

---

## 1. Goal

Build a pre-registered, CLI-only experiment harness that runs 2,400 trials (10 fixtures × 4 modes × 30 seeds × 2 replications) comparing Claude execution modes (D / P-fresh / P-accumulated / S) on four orthogonal metrics (cost, quality, pollution, loss) per the v3-max.1 spec, producing a HELM-style orthogonal result table and heatmaps that the `aigentry-analyst` session will turn into a decision tree.

## 2. Architecture

### 2.1 Dataflow

```
                      ┌─────────────────────────────────────────────┐
                      │  run_orders/*.csv  (pre-registered seed →   │
                      │   trial ordering, RNG=42, commit-locked)    │
                      └──────────────────────┬──────────────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  bin/exec-mode-experiment.sh            (orchestrator, bash)         │
│  ─────────────────────────────────────────────────────────────────   │
│  for trial in run_order:                                             │
│    ├─ checkpoint_resume()          ← skip if metrics.json exists     │
│    ├─ stage1_setup(mode)           ← D|Pfresh|Pacc|S divergent paths │
│    ├─ stage1_execute()   ──────────┐                                 │
│    │     D   : open-session.sh  → telepty inject task prompt         │
│    │     Pfr : open-session.sh  → replay warmup turns → task         │
│    │     Pac : resume session k → inject fixture[k] task             │
│    │     S   : Task tool dispatch (general-purpose subagent)         │
│    ├─ stage1_capture_jsonl()       ← slice ~/.claude/projects/.../*.jsonl
│    │                                 by timestamp window             │
│    ├─ stage1_parse_cost() ─────────► grader.parse_cost(jsonl)        │
│    ├─ stage1_primary_grader() ─────► grader.score_fixture(Fx, out)   │
│    ├─ stage1_pollution_A() ────────► grader.regex_leaks(out, facts)  │
│    ├─ stage1_compact_detect() ────► grader.detect_compact(jsonl)     │
│    ├─ stage2_probe_session()       ← fresh `claude --print`          │
│    │     input = transcript + shuffled(probes, seed=trial)           │
│    ├─ stage2_loss_A()              ← exact match                     │
│    ├─ stage2_loss_B()              ← rapidfuzz > 0.8                 │
│    ├─ stage2_loss_C() ─────────────► grader.dual_judge(codex,gemini) │
│    └─ emit metrics.json            ← atomic write, schema §5         │
└────────────────────────────────────┬────────────────────────────────┘
                                     │  (deferred, post-run batch)
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  bin/exec-mode-grader.py  (--deferred)   (python 3.14, subprocess)  │
│  ─────────────────────────────────────────────────────────────────   │
│  Jury: 5 judges (3 claude + 1 codex + 1 gemini) × order-swap         │
│  Pollution Layer B (dual cross-family) for ambiguous regex cases     │
│  Loss Layer C adjudication queue                                     │
│  Writes: metrics.jury.json alongside each metrics.json               │
└────────────────────────────────────┬────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  bin/exec-mode-analyze.py         (python 3.14, pandas+scipy)       │
│  ─────────────────────────────────────────────────────────────────   │
│  metrics.json × 2,400 → DataFrame                                   │
│  bootstrap 95% CI per (fixture, mode) cell, 10k resamples           │
│  Krippendorff α on 10% judge subsample                              │
│  4 heatmaps (cost, quality, pollution, loss) + HELM table           │
│  Output: report/v3-max-results-{replication}.md + heatmaps/*.png    │
│          + report/data.csv                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Module boundaries (why split)

- **Executor (bash)**: OS-level session spawning belongs to bash — `open-session.sh`, telepty, Task-tool dispatch are already bash-native in this repo. Rule 26 (Cross-OS) routes through `bin/lib/platform.sh`.
- **Grader (python)**: regex / rapidfuzz / JSONL parsing are cheaper in Python; batched CLI jury calls need retry + backoff loops that are painful in bash.
- **Analyzer (python)**: pandas + scipy.stats.bootstrap live here. Pure, offline, re-runnable.
- **Fixtures (orchestrator repo)**: Rule 4 영역 경계 — fixtures are *test data*, not devkit code. They live under `aigentry-orchestrator/fixtures/exec-mode-experiment/F{X}/`.

### 2.3 Resumability

Every trial writes `metrics.json` atomically (`write-to-tmp + rename`) under:
```
state/exec-mode-experiment/{replication_tag}/{mode}/{fixture}/seed{NN}[_pos{P}_sess{S}]/metrics.json
```
Harness start: scan state tree; any existing `metrics.json` with `schema_version` matching current → skip. Partial writes (no file, or invalid JSON) → re-run trial. P-accumulated resumes mid-chain by replaying prior fixtures from that session's `.chain_state.json` or by aborting the session and re-queuing (decision below in §6 R8).

---

## 3. Module layout

```
aigentry-devkit/
├── bin/
│   ├── exec-mode-experiment.sh           (NEW, ~600 LoC bash)
│   ├── exec-mode-grader.py               (NEW, ~800 LoC python)
│   ├── exec-mode-analyze.py              (NEW, ~400 LoC python)
│   ├── exec-mode-generate-order.py       (NEW, ~150 LoC python — §7.5 run_orders)
│   └── lib/
│       ├── exec-mode-lib.sh              (NEW, ~300 LoC — shared bash helpers)
│       └── platform.sh                   (EXISTING, reused for event_wait/kill_pid)
└── tests/
    └── exec-mode/
        ├── fixtures/                     (golden test inputs)
        │   ├── sample_session.jsonl      (mock claude JSONL, 3 turns)
        │   ├── sample_compact.jsonl      (pre-recorded compact event)
        │   └── sample_output_Fa.md       (mock agent output for grader tests)
        ├── test_cost_parser.py
        ├── test_pollution_regex.py
        ├── test_loss_fuzzy.py
        ├── test_compact_detect.py
        ├── test_harness.bats             (bats-core; dry-run path only)
        └── test_analyzer.py

aigentry-orchestrator/
└── fixtures/exec-mode-experiment/
    ├── canonical_briefing.md             (EXISTING, locked)
    ├── warmup_transcript.md              (EXISTING, locked)
    ├── F2/ … F10/ Fa/                    (NEW, 10 fixture dirs)
    │   ├── setup_history.md              (prior turns, 10 planted facts distributed)
    │   ├── task_prompt.md
    │   ├── post_probes.md                (10 probes)
    │   ├── ground_truth.json             (primary grader criteria)
    │   ├── planted_facts.json            (10 × {id, keyword, sentence, paraphrase_examples})
    │   ├── probe_answers.json            (10 × expected answer)
    │   └── warmup_transcript.md          (per-fixture P-fresh replay)
    └── run_orders/
        ├── run_order_D.csv
        ├── run_order_Pfresh.csv
        ├── run_order_Pacc.csv
        └── run_order_S.csv
```

### 3.1 Key interface signatures

#### `bin/exec-mode-experiment.sh`

```bash
# CLI contract (spec §7.1)
exec-mode-experiment.sh \
  --fixture FX \
  --mode D|Pfresh|Pacc|S \
  --seed-idx N \
  [--session-idx S]          # Pacc only
  [--position-in-chain P]    # Pacc only
  --run-idx N                # replication 1|2
  [--dry-run]                # skip all LLM calls; emit synthetic metrics for harness tests
  [--resume]                 # honor existing metrics.json checkpoints

# Output: state/.../metrics.json (schema §5 of spec)
# Exit codes: 0=ok, 2=timeout, 3=rate-limit-exhausted, 4=compact-blocked, 5=malformed-fixture
```

Key internal functions (in `exec-mode-lib.sh`):
```bash
execmode::stage1_setup(mode, fixture, seed, session_idx?)  → session_id
execmode::stage1_execute(session_id, fixture)              → stdout to $trial_output
execmode::stage1_capture_jsonl(session_id, start_ts, end_ts) → $trial_jsonl
execmode::stage2_probe(transcript_file, probes_file, seed) → answers.json
execmode::compact_detect(trial_jsonl)                      → bool + reason
execmode::retry_with_backoff(max=3, timeout=30, cooloff=60, cmd…)
execmode::emit_metrics(path, key=val …)                    → atomic write
```

#### `bin/exec-mode-grader.py`

```python
# stdlib + rapidfuzz only; LLM via subprocess
def parse_cost(jsonl_path: Path, include_subagents: bool = True) -> CostBuckets
def detect_compact(jsonl_path: Path, drop_ratio: float = 0.5, spike_mult: float = 2.0) -> CompactFlag
def score_primary(fixture_id: str, agent_output: str, ground_truth: dict) -> float        # 0..1
def pollution_layer_a(output: str, facts: list[PlantedFact]) -> list[bool]
def pollution_layer_b_dual(output: str, facts: list[PlantedFact]) -> list[LeakVerdict]   # codex+gemini
def loss_layer_a(expected: str, actual: str) -> bool
def loss_layer_b(expected: str, actual: str, threshold: float = 0.8) -> bool             # rapidfuzz
def loss_layer_c_dual(q: str, expected: str, actual: str) -> LossVerdict                 # codex+gemini
def jury_score(transcript: str, agent_output: str) -> list[JudgeScore]                   # 5 judges × order-swap
def krippendorff_alpha(scores: np.ndarray) -> float                                      # stdlib impl
```

#### `bin/exec-mode-analyze.py`

```python
def load_metrics(state_root: Path) -> pd.DataFrame
def bootstrap_ci(values: np.ndarray, n_resample: int = 10000, ci: float = 0.95) -> tuple[float,float,float]
def helm_table(df: pd.DataFrame) -> pd.DataFrame
def heatmap(df: pd.DataFrame, metric: str, out_png: Path) -> None
def position_effect_plot(df: pd.DataFrame, fixture: str, out_png: Path) -> None          # Pacc only
def compact_rate_table(df: pd.DataFrame) -> pd.DataFrame
def write_report(df: pd.DataFrame, out_md: Path) -> None
```

### 3.2 Per-fixture primary grader registry

`grader.py` holds a dispatch dict so fixture-specific logic stays one-function-per-fixture:

```python
PRIMARY_GRADERS = {
    "F2":  score_f2_invariants,        # regex substring preservation
    "F3":  score_f3_severity_f1,       # issue-ID matching with severity weights
    "F4":  score_f4_oracle_graph,      # entity+edge + hallucinated-node penalty
    "F5":  score_f5_citations,         # URL liveness via `curl -sI` + claim spot-check via claude CLI
    "F6":  score_f6_build_turns,       # binary + turns-to-success (parsed from trial log)
    "F7":  score_f7_latest_decision,   # superseded rejection + citation-to-turn
    "F8":  score_f8_hidden_tests,      # pytest hidden + duplication_reduction(structural)
    "F9":  score_f9_root_cause,        # exact match on planted cause keyword
    "F10": score_f10_checklist,        # unresolved-checklist apply rate + stale rejection
    "Fa":  score_fa_false_prior,       # binary leak (0 good) + task correctness + citation
}
```

---

## 4. Dependency map

| Component | Dependency | Version | Source | Already installed? |
|---|---|---|---|---|
| grader, analyzer | python | 3.14.2 | `/opt/homebrew/bin/python3.14` | ✅ (verified) |
| grader | rapidfuzz | ≥3.9 | pip (venv) | ❌ pin in `requirements-exec-mode.txt` |
| analyzer | pandas | ≥2.2 | pip (venv) | ❌ pin |
| analyzer | scipy | ≥1.17 | pip (venv) | ✅ 1.17.0 |
| analyzer | matplotlib | ≥3.10 | pip (venv) | ✅ 3.10.8 |
| harness | claude CLI | pinned `claude --version` output recorded at run-start | `/Applications/cmux.app/.../claude` | ✅ |
| harness, grader | codex CLI | pinned | `/opt/homebrew/bin/codex` | ✅ |
| grader | gemini CLI | pinned (Gemini 2.5 Pro account) | `$NVM/bin/gemini` | ✅ |
| harness | telepty | pinned | `$NVM/bin/telepty` | ✅ |
| harness | bash | ≥5 | system | ✅ |
| harness | `bin/lib/platform.sh` | repo-local | `bin/lib/platform.sh` | ✅ |
| tests (bash) | bats-core | ≥1.10 | brew (dev-only) | verify at Task 0 |
| tests (python) | pytest | ≥8 | pip | verify at Task 0 |
| tests (shell lint) | shellcheck | ≥0.10 | brew | ✅ (used elsewhere) |

**Isolation**: create `aigentry-devkit/.venv-exec-mode` via `python3.14 -m venv`; harness and grader invoke it by absolute path. Do not touch global site-packages.

**CLI version recording**: at trial start, harness writes `state/.../cli_versions.json` with `claude --version`, `codex --version`, `gemini --version`, `telepty --version` outputs. Analyzer reads this to flag cross-replication model drift (spec §10 "Replication 시간차").

---

## 5. Risk list

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Claude CLI JSONL schema drift between invocations of the same trial (cache field renamed) | Low | High | Pin claude CLI version at run-start (`cli_versions.json`); parser keyed on `usage.input_tokens` + `usage.cache_read_input_tokens` + `usage.cache_creation_input_tokens` which are stable; golden-JSONL test fixture at `tests/exec-mode/fixtures/sample_session.jsonl` catches schema changes in CI. |
| R2 | `telepty inject` race with session startup → task prompt lost | Medium | High | Use `platform::event_wait` on a known marker string printed by `open-session.sh` completion hook; retry x3 with exponential backoff. Existing `open-session.sh` already prints `[SESSION READY name=<name>]` — reuse that marker. |
| R3 | Compact detection false positive (normal cache eviction, not mid-task compact) | Medium | Medium | Two-signal rule per spec §8: `cache_read_tokens drop >50%` **AND** `next_input_tokens > 2× avg`. Unit-test against a golden compact JSONL + a golden non-compact JSONL. Flag-only, never delete data. |
| R4 | Subagent nested cost roll-up misses deeply-nested spawns | Low | Medium | Recursive glob `**/subagents/**/*.jsonl` rooted at project dir; parse each; join by parent_agent_id field if present. Test fixture with 2-level nesting. |
| R5 | Codex/Gemini rate-limit during Layer B/C batch → hours of re-queue | Medium | Medium | 60s cool-off + 3 retries per spec §7.1. Jury + Layer B are deferred post-run, so rate limits slow the report but don't lose trials. |
| R6 | P-accumulated session exceeds 200K context → forced compact mid-chain → unfair to later positions | High | Low (by design) | spec §8 stratum split: primary report separates `n_valid_nocompact` vs `n_compact_stratum`. Harness just *detects and marks*, does not abort. Compact rate IS a reported metric. |
| R7 | Fixture authoring subjectivity (10 planted facts too similar, regex collisions) | Medium | High | Lint script `tests/exec-mode/test_fixture_lint.py` enforces: ≤2500 tokens, exactly 10 facts, no pairwise substring overlap between keywords, 10 probes align 1:1 with facts, turn delimiters valid. Run before tag. |
| R8 | P-acc resume from checkpoint is ambiguous (session state lost if crashed mid-chain) | Medium | Medium | Decision: on any Pacc session crash, **discard entire session's trials** (sessions 1–30 are independent so rerun is cheap) + log incident. Partial chains pollute variance estimates. Tracked in `state/.../incidents.jsonl`. |
| R9 | Cross-family judge disagreement (Gemini 2.5 Pro systematically stricter) | Medium | Low | Per-family agreement reported separately (§5 analysis-plan exploratory). Krippendorff α threshold 0.8 triggers M3 remediation (4th variant + full rescore) per spec §5.2. |
| R10 | SPEC drift: reviewer pressure to add McNemar / cosine pollution back in | Low | Critical | Spec locked by git tag. Every design citation in this doc includes spec line #. Any change requires orchestrator-approved `changes_log` entry in analysis-plan. |
| R11 | Fixture task unintentionally elicits probe topic in Stage 1 | Medium | High | Fixture lint (#R7) also checks that probe question keywords do NOT appear in `task_prompt.md`. Peer-review per fixture before tag. |
| R12 | P-fresh warmup replay inflates cache_creation cost differently from D briefing | Medium | Low (by design) | Expected — warmup cost goes into `warmup_cost`; amortization n=1/10/30 reports exactly this. Analyzer plots all three amortizations (spec §5.1 Medium 1 fix). |
| R13 | `.venv-exec-mode` path collision with user's project venv | Low | Low | Name is `.venv-exec-mode` (suffixed), not `.venv`; added to `.gitignore`. |
| R14 | Hard-coded `$HOME=/Users/duckyoungkim` creeps in from dev box | Medium | Medium | CLAUDE.md Rule 14; harness uses `$HOME` and `XDG_STATE_HOME` only; lint grep in CI: `rg -n "duckyoungkim" bin/exec-mode-* tests/exec-mode/` → must be empty. |

---

## 6. TDD strategy

**Principle**: TDD is rigid per `superpowers:test-driven-development`. For every measurement function, write the failing test against a golden fixture first, then implement.

### 6.1 Test pyramid

1. **Unit (fastest, most)**:
   - `test_cost_parser.py` — golden JSONL → expected bucket totals
   - `test_pollution_regex.py` — known output + facts → known leak vector
   - `test_loss_fuzzy.py` — rapidfuzz threshold edge cases (0.79 / 0.81)
   - `test_compact_detect.py` — golden compact vs non-compact JSONL
   - `test_analyzer.py` — hand-built 12-row DataFrame → known bootstrap CI (seeded resample)

2. **Integration (bash, dry-run mode)**:
   - `test_harness.bats` — `exec-mode-experiment.sh --dry-run --fixture Fa --mode D --seed-idx 0 --run-idx 1` emits a well-formed `metrics.json` without invoking any LLM. Schema validated against `state/schema/metrics.v1.json`.
   - Verifies Stage 1 / Stage 2 separation: Stage 2 subprocess has `CLAUDE_SESSION_ID` unset and gets probes as stdin, not via shared session.

3. **Contract (LLM-live, gated)**:
   - `tests/exec-mode/smoke_live.sh` — 1 trial × Fa × D (real claude CLI). Run manually before Phase 1 close. Not in CI (costs money).

### 6.2 Which fixture goes first: **Fa**

- Simplest logic (binary leak + task correctness + citation — all parseable with regex + rapidfuzz).
- Smallest setup_history (~1200 tokens target, well under 2500 cap).
- "False Prior Override" is the ONE fixture whose expected winner (D/S) is least controversial — good sanity signal that harness works end-to-end before investing in harder fixtures.
- Per inject: "F1 replaced by Fa". Fa is Phase-1 scope.

### 6.3 Fixture lint-before-commit gate

```bash
python3.14 tests/exec-mode/test_fixture_lint.py fixtures/exec-mode-experiment/Fa
# checks:
#  - setup_history.md token count (tiktoken via `claude --count-tokens` or tokenizer stub) ≤ 2500
#  - planted_facts.json has exactly 10 entries, unique keywords, no pairwise substring overlap
#  - probe_answers.json aligned 1:1 with post_probes.md Q ordering
#  - post_probes.md keywords NOT present in task_prompt.md (R11)
#  - warmup_transcript.md has same 10 planted facts (exact keyword match)
#  - all turn delimiters `--- Turn N ---` or `--- User|Agent (Turn N) ---` well-formed
```

This is a test AND a gate: no fixture merges into the pre-registered set until it passes.

### 6.4 Commit cadence

Per `superpowers:test-driven-development`: red → green → refactor → commit. Every task below ends with a commit. No WIP commits — run `npm test` (syntax check) and relevant pytest subset before each commit.

---

## 7. Work breakdown (Phase 1 → Phase 3)

All estimates are wallclock with focus; actual runtime depends on LLM latency for smoke tests.

### Phase 1 (after `[IMPLEMENT APPROVED]`) — harness + grader core + Fa

| # | Task | Files | Time | Gate |
|---|---|---|---|---|
| **T1** | Scaffold `.venv-exec-mode`, `requirements-exec-mode.txt`, pin claude/codex/gemini/telepty CLI versions, add `state/schema/metrics.v1.json` JSON Schema | `requirements-exec-mode.txt`, `state/schema/metrics.v1.json`, `.gitignore` | 1h | venv activates; `python3.14 -c "import rapidfuzz, pandas"` clean |
| **T2** | `bin/lib/exec-mode-lib.sh` helpers: `execmode::retry_with_backoff`, `emit_metrics`, `stage1_capture_jsonl` (jsonl window slicer), `compact_detect` wrapper — TDD via bats | `bin/lib/exec-mode-lib.sh`, `tests/exec-mode/test_execmode_lib.bats` | 3h | `bats tests/exec-mode/test_execmode_lib.bats` green; `shellcheck` clean |
| **T3** | `bin/exec-mode-grader.py` Part 1: `parse_cost`, `detect_compact`, `pollution_layer_a`, `loss_layer_a`, `loss_layer_b` (stdlib + rapidfuzz only, NO subprocess) — TDD | `bin/exec-mode-grader.py`, `tests/exec-mode/test_cost_parser.py`, `test_pollution_regex.py`, `test_loss_fuzzy.py`, `test_compact_detect.py`, golden JSONL fixtures | 4h | `pytest tests/exec-mode/ -k 'parser or pollution or loss or compact'` all green |
| **T4** | `bin/exec-mode-grader.py` Part 2: `pollution_layer_b_dual` + `loss_layer_c_dual` via codex + gemini subprocess; retry/backoff shared with bash layer; mock-subprocess tests | same + `test_grader_subprocess.py` (monkeypatch) | 3h | `pytest tests/exec-mode/test_grader_subprocess.py` green with mocked subprocesses |
| **T5** | `bin/exec-mode-experiment.sh` Stage 1 executor — D + S modes only this task (P-fresh/P-acc in T6). Uses `open-session.sh` for D; Task-tool fanout for S via telepty inject to builder. `--dry-run` path complete. | `bin/exec-mode-experiment.sh`, `tests/exec-mode/test_harness.bats` | 4h | `exec-mode-experiment.sh --dry-run --mode D --fixture Fa …` emits valid `metrics.json` (schema-validated) |
| **T6** | Stage 1 executor — P-fresh warmup replay + P-accumulated session resume. Warmup turns injected via telepty one-at-a-time with `platform::event_wait` between. P-acc session state kept in `.chain_state.json`. | `bin/exec-mode-experiment.sh`, `bin/lib/exec-mode-lib.sh` | 3h | `--dry-run` for both modes emits valid metrics; P-acc resume test (simulate crash mid-chain → discard session) |
| **T7** | Stage 2 probe-replay subprocess spawner. Isolation invariant: no env vars leaking session id; stdin-only probe delivery. Integration test verifies Stage 1 session never sees probe text (grep-based). | `bin/exec-mode-experiment.sh`, `tests/exec-mode/test_stage_isolation.bats` | 2h | Isolation test green; one real `claude --print` call against a fixture transcript returns parseable JSON answers |
| **T8** | Fa fixture package: `setup_history.md`, `task_prompt.md`, `post_probes.md`, `ground_truth.json`, `planted_facts.json`, `probe_answers.json`, `warmup_transcript.md` | `aigentry-orchestrator/fixtures/exec-mode-experiment/Fa/*` | 3h | `test_fixture_lint.py Fa` all checks pass |
| **T9** | `score_fa_false_prior` primary grader + fixture-grader dispatch registry | `bin/exec-mode-grader.py`, `tests/exec-mode/test_grader_fa.py` | 2h | known-good / known-bad agent outputs map to expected scores |
| **T10** | Live smoke test: 1 trial per mode × Fa = 4 trials. Record cost, verify all 4 metrics present, 2-stage isolation works, compact flag respected. | `tests/exec-mode/smoke_live.sh`, `docs/reports/2026-04-??-exec-mode-Fa-smoke.md` | 2h | Report posted; zero schema errors; all 4 metrics in range |

**Phase 1 total**: ~27h. End of Phase 1 = orchestrator review → proceed to Phase 2.

### Phase 2 (after Phase 1 validation) — remaining 9 fixtures + analyzer

| # | Task | Files | Time |
|---|---|---|---|
| **T11** | Fixtures F2, F3, F4, F10 + their primary graders (simpler cluster per spec §4.2: Cluster 1 + fresh Cluster 2) | 4 fixture dirs, `grader.py` additions, `test_grader_{f2,f3,f4,f10}.py` | 10h |
| **T12** | Fixtures F5, F6, F9 + graders (F5 URL liveness via `curl`, F6 iterative build, F9 root cause) | 3 fixture dirs + graders + tests | 8h |
| **T13** | Fixtures F7, F8 + graders (F7 semantic masking — hardest; F8 hidden pytest suite) | 2 fixture dirs + graders + tests | 6h |
| **T14** | `bin/exec-mode-generate-order.py` + commit `run_orders/*.csv` for all 4 modes (RNG=42) | generator + 4 CSVs | 2h |
| **T15** | `bin/exec-mode-analyze.py` — DataFrame load, bootstrap CI, HELM table, 4 heatmaps, compact-rate table, Krippendorff α. Uses pre-made 12-row synthetic DataFrame for unit tests. | `bin/exec-mode-analyze.py`, `tests/exec-mode/test_analyzer.py` | 6h |
| **T16** | Jury batching (5 judges × order-swap) in `grader.py --deferred` mode. Writes `metrics.jury.json` alongside each trial's metrics.json. | grader.py additions, `test_jury_batching.py` | 4h |
| **T17** | Fixture lint gate integrated into pre-tag workflow; docs note. | `tests/exec-mode/test_fixture_lint.py` final, `docs/exec-mode-prerun-checklist.md` | 2h |

**Phase 2 total**: ~38h. End of Phase 2 = orchestrator tags `exec-mode-prerun-YYYYMMDD` → Phase 3.

### Phase 3 — pilot (not part of this build spec's commitment; called out for completeness)

| # | Task | Notes |
|---|---|---|
| **T18** | Pilot run: 10 fixtures × 3 first modes (D, P-fresh, S) × 1 seed = 30 trials. Verify variance, cost, compact behavior, judge agreement. | budget ~$30-50 |
| **T19** | Pilot analyst handoff per spec §9 P3 | descriptive only |

**Phase 1 + Phase 2 commitment**: ~65h total build before pilot; fits in ~2-week sprint if full-time on this.

---

## 8. Invariants locked by this plan

- **CLI-only**: No `import anthropic|openai|voyageai` — grep in CI (R14 mechanism).
- **Spec lock**: no new metrics, no new modes, no McNemar, no cosine pollution, no in-band probes. Any change path goes through orchestrator + analysis-plan change log.
- **2-stage isolation**: Stage 1 never sees probe text; Stage 2 never shares session id (test T7).
- **Resume-safe**: all writes atomic; resumption reads existing metrics.json and skips.
- **Rule 14**: no `/Users/duckyoungkim` in source — `$HOME`/`$XDG_STATE_HOME` only.
- **Rule 4**: devkit holds harness/grader/analyzer; orchestrator holds fixtures. No crossover.

## 9. Handoff

Upon `[IMPLEMENT APPROVED]`, begin Phase 1 at **T1** and proceed strictly in numerical order. Each task ends with commit + short report to orchestrator:
```
telepty inject --from E-harness-builder aigentry-orchestrator \
  'TASK Tn DONE | files: ... | tests: ... | next: Tn+1'
```

Phase 1 close (after T10 smoke report) blocks on orchestrator review before Phase 2 begins.

---

## 10. Changes log

| Date | Change | Reason |
|---|---|---|
| 2026-04-20 | Initial build spec submitted for orchestrator review | Phase 0 per inject |
