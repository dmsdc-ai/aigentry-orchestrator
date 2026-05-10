# Graders Primaries Review — Post Codex 5e01637

**Reviewer**: `E-grader-review` session (Claude, dispatched 2026-04-20)
**Commit under review**: `5e01637 feat(exec-mode): 9 primary graders F2-F10 (#329 A1 fix)`
**Spec source of truth**: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` (locked at tag `exec-mode-v3-max-preregistered-20260420`)
**Files reviewed**:
- `~/projects/aigentry-devkit/bin/exec-mode-grader.py` (lines 910-1654, graders F2-F10 + Fa + dispatch)
- `~/projects/aigentry-devkit/tests/exec-mode/test_grader_f{2..10}.py` (9 files)
- `~/projects/aigentry-devkit/tests/exec-mode/test_primary_graders_dispatch.py`
- `~/projects/aigentry-orchestrator/fixtures/exec-mode-experiment/F{2..10,a}/ground_truth.json` (10 fixtures)

**Verdict**: **APPROVE_WITH_FIXES**

Summary: Implementation is mostly correct and well-tested (dispatch + return-shape + edge cases). 3 spec deviations are **pre-registration breaches** that invalidate pilot data unless fixed, and several gates are too narrow / brittle for real agent outputs. Strengths: dispatch + Fa integration preserved, empty-output graceful degradation, clamped primary_score ∈ [0, 1].

---

## Critical issues (🔴) — must fix before pilot retry

### 🔴 C1. F5 spot-check uses curl HEAD + rapidfuzz, not Claude CLI judge

**Where**: `bin/exec-mode-grader.py:895-907` (`_quote_supported_by_url`), called at `:1174`.

**Spec deviation**: Spec §5.2 Layer 1 F5 bullet explicitly says **"claim-citation (3 spot checks via Claude CLI)"**. Fixture `F5/ground_truth.json:55-58` says `"spawn Claude CLI judge with prompt: 'Does the quoted sentence appear in this source, substantively? yes/no'"`. Implementation uses `_run_curl` to fetch the URL body, then local `rapidfuzz.partial_ratio ≥ 0.88` to judge quote ↔ page alignment. No Claude CLI invocation.

**Impact**: The grader diverges from declared methodology after the pre-registration tag was cut. Any F5 scores produced this way cannot be published as spec-v3-max.1 results without re-labeling.

**Proposed fix** (code sketch, line 1173-1175):
```python
spot_sample = random.Random(int(ground_truth.get("trial_seed", 42))).sample(
    primary_citations, min(3, len(primary_citations))
)
spot_hits = 0
for item in spot_sample:
    body = _run_curl(item["url"], head=False)
    if body is None or body.returncode != 0:
        continue
    snippet = _normalise_text(body.stdout)[:4000]  # cap prompt size
    prompt = (
        f'Does this quoted sentence appear substantively in the source text?\n'
        f'QUOTE: "{item["quote"]}"\n'
        f'SOURCE EXCERPT: {snippet}\n'
        f'Answer only "yes" or "no".'
    )
    verdict = _judge_cli("claude", prompt)
    if verdict and verdict.strip().lower().startswith("y"):
        spot_hits += 1
spot_rate = _safe_div(spot_hits, len(spot_sample))
```

(`_judge_cli` already exists at `:327` and handles retries/rate-limit.)

### 🔴 C2. F5 spot-check selects first-3 citations instead of random sample

**Where**: `bin/exec-mode-grader.py:1173`: `spot_sample = primary_citations[:3]`.

**Spec deviation**: Fixture `F5/ground_truth.json:55` says **"Randomly sample 3 citation blocks"**. Deterministic first-3 lets agents game by front-loading good citations.

**Proposed fix**: Folded into C1 above (`random.Random(seed).sample(...)`). Seed must come from pre-registered `trial_seed` so replication is reproducible.

### 🔴 C3. F10 unresolved-checklist gates on `must_reference_turn_any_of`, but spec says match_regex only

**Where**: `bin/exec-mode-grader.py:1497-1503`:
```python
content_hit = bool(_regex_any_hit(next_section, item.get("match_regex_any_of") or []))
turn_hit = any(
    re.search(rf"\bTurn\s*{int(turn)}\b", next_section, re.IGNORECASE)
    for turn in item.get("must_reference_turn_any_of") or []
)
if content_hit and turn_hit:
    unresolved_hits.append(item.get("id", ""))
```

**Spec deviation**: Spec §4.2 F10 Primary Grader says "unresolved checklist apply rate + stale rejection rate". Fixture `F10/ground_truth.json:63` defines `unresolved_application_rate` as **"fraction of hidden_unresolved_checklist.items matched in (b) Next actions section (per match_regex_any_of)"** — no turn requirement. The grader adds a hidden turn-citation gate that the spec/fixture do not declare.

**Impact**: Correct agents who describe the unresolved item (e.g., "Implement email validator.js for bulk import") but don't cite "Turn 4/5" score **0** on that item instead of 1. Because F10 is a 2-item checklist, a single gate miss drops primary_score by 0.25 — a large, undocumented penalty.

**Proposed fix** (line 1502):
```python
if content_hit:
    unresolved_hits.append(item.get("id", ""))
# optionally track turn_hit separately as bonus in secondary_signals
```
Or make turn-citation a 0.5× partial credit rather than a hard gate — but either way, document the choice in fixture JSON and keep grader in sync.

---

## High issues (🟡) — should fix (correctness / brittleness)

### 🟡 H1. F9 red-herring regexes hardcoded in grader, not sourced from fixture

**Where**: `bin/exec-mode-grader.py:1456-1460` hardcodes R1/R2/R3 patterns (`off[-\s]?by[-\s]?one|loop\s*bound`, `overflow|backoff|2\s*\*\*\s*attempts`, `promise|then\s*chain|await`). Fixture `F9/ground_truth.json:7-23` lists `file_local_red_herrings` as prose descriptions with no regex field.

**Impact**: Fixture ↔ grader drift. Changing the fixture scenario won't flow into the grader. Fails "spec-driven grading" principle (Rule 22 speculative assertion adjacent — the grader is making up test criteria not in fixture).

**Proposed fix**:
1. Add to fixture:
   ```json
   "file_local_red_herrings": [
     {"id": "R1", "description": "...", "match_regex_any_of": ["off[-\\s]?by[-\\s]?one", "loop\\s*bound"]},
     ...
   ]
   ```
2. Replace hardcoded block with:
   ```python
   red_herrings = {
       r["id"]: r.get("match_regex_any_of") or []
       for r in ground_truth.get("file_local_red_herrings") or []
       if r.get("id") != ground_truth.get("true_root_cause", {}).get("id")
   }
   ruled_out = [rid for rid, pats in red_herrings.items() if _regex_any_hit(evidence_section, pats)]
   ```

### 🟡 H2. F10 hallucination_penalty contaminates primary_score (spec marks it secondary)

**Where**: `bin/exec-mode-grader.py:1529`: `score = 0.5 * unresolved_rate + 0.5 * stale_rate - hallucination_penalty`.

**Spec deviation**: Fixture `F10/ground_truth.json:65` formula is **`0.5 * (matched_unresolved / 2) + 0.5 * (matched_stale / 3)`** exactly — no penalty. The `no_hallucinated_next_action` field lives under `secondary_signals` (`:68`), not primary.

**Impact**: An agent with perfect unresolved+stale coverage but one incidental "refactor" mention drops 0.05 from primary. Contaminates inter-grader comparability with Layer 2 jury.

**Proposed fix** (line 1529):
```python
score = 0.5 * unresolved_rate + 0.5 * stale_rate  # primary only
primary_score = round(_clamp01(score), 4)
# hallucination_penalty reported separately in return dict as secondary signal
```
Keep `hallucinated_next_action_hits` and `hallucination_penalty` in the return dict, just don't subtract from primary.

### 🟡 H3. F7 `banned_pattern_detect_regex` silent false-positive on empty fallback

**Where**: `bin/exec-mode-grader.py:1265`:
```python
either_type_present = bool(_regex_any_hit(text, [checks.get("banned_pattern_detect_regex", "")]))
```

**Impact**: If fixture omits the key, `checks.get(..., "")` → `""`. `re.search("", text)` always matches at position 0, so `_regex_any_hit` returns `[""]`, `either_type_present = True`, primary_score gets multiplied by 0.3. Silent corrupted score with no warning.

**Proposed fix** (line 1265):
```python
banned_pat = checks.get("banned_pattern_detect_regex")
either_type_present = bool(banned_pat) and bool(re.search(banned_pat, text))
```
Fails fast on real misconfiguration instead of silent penalty.

### 🟡 H4. F4 file-reference regex false-flags short names as hallucinations

**Where**: `bin/exec-mode-grader.py:1057-1058`:
```python
file_like_refs = sorted(set(re.findall(r"[\w./-]+\.(?:rs|py|toml|udl|md)", text)))
hallucinated_nodes = [ref for ref in file_like_refs if ref not in nodes]
```

**Impact**: If agent writes `codec.rs` (basename only, no path), it's not in oracle `nodes` (which hold full paths like `crates/voxlite-core/src/codec.rs`). Flagged as hallucination → 0.1 × penalty even when semantically correct. Penalizes terse styles.

**Proposed fix** (line 1058):
```python
node_basenames = {Path(n).name for n in nodes}
hallucinated_nodes = [
    ref for ref in file_like_refs
    if ref not in nodes and Path(ref).name not in node_basenames
]
```

### 🟡 H5. F6 grader is text-level proxy only, not real build execution

**Where**: `bin/exec-mode-grader.py:1211-1255`. Checks diff format + fix regex + anti-pattern + prediction string, no `subprocess.run` of `uv run pytest`.

**Spec position**: Spec §4.2 F6 says "build pass (binary) + turns-to-success". Fixture provides `build_command: "uv run pytest aigentry_config/tests/test_loader.py -x"` and `build_green_criteria`. Spec §7.1 harness step 5 says "run fixture-specific Python grader on task output" — text-level. Actual build execution is left ambiguous between grader and harness.

**Impact**: An agent producing the correct semantic fix in a slightly different diff dialect (e.g., `git diff` without `@@.*@@`, or a single-line code replacement sans `---/+++`) scores 0 despite correctness. Pilot may under-measure F6 quality on valid agent output.

**Proposed fix**:
- Either (a) explicitly document `score_f6_build_turns` as a single-turn text proxy and move true build-pass detection to the harness (apply diff + run pytest + feed result back), **or** (b) enhance grader with `_apply_unified_diff(agent_output, source_file) -> patched` + `subprocess.run(build_command, cwd=...)`. Option (b) is heavier but matches fixture intent.
- Short-term patch: loosen `diff_format_regex` acceptance (e.g., also accept `*** a/... --- b/...` context-diff form, or raw code-block with correct final state).

### 🟡 H6. F8 behavioral-test mapping is regex-heuristic, not real execution

**Where**: `bin/exec-mode-grader.py:1349-1367`. Maps each hidden test kind to a string-match heuristic, e.g., `i18n_email` passes iff `re.search(r"\[\^\\s@]\+@\[\^\\s@]\+\\\.\[\^\\s@]\+", validators)` — literally looks for that exact regex string in agent output.

**Impact**: An agent using `validator.isEmail()` from a library, or a different-but-equivalent regex (`.+@.+\..+`, or `/\S+@\S+\.\S+/i`), scores 0 on "valid implementation". False-negative rate on F8 will be high once real agents diverge from the sketch output.

**Proposed fix**: Ideally, execute the agent's validators under Node (sandboxed) against the 8 test cases. CLI-only constraint (no SDK) still allows `subprocess.run(["node", "-e", script])`. Minimal version:
```python
def _run_hidden_tests_via_node(validators_body: str, wrappers: dict, cases: list) -> list[dict]:
    script = f"""
    {validators_body}
    {wrappers['src/ingest/orders.ts']}
    // ... etc
    const results = [];
    {''.join(f"results.push({{ kind: '{c['kind']}', passed: /* eval each case */ }});" for c in cases)}
    console.log(JSON.stringify(results));
    """
    proc = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=10)
    return json.loads(proc.stdout)
```
Short-term mitigation: broaden email_regex_ok to accept 3-4 common forms (`\S+@\S+`, `/.+@.+\..+/`, `validator.isEmail`, `email-validator`).

### 🟡 H7. Fa primary_score is binary {0.0, 1.0}, discards task_correctness granularity

**Where**: `bin/exec-mode-grader.py:1628`: `"primary_score": 1.0 if primary_pass else 0.0`.

**Impact**: Partial task_correctness (0.25/0.5/0.75) collapses to 0 unless ≥0.75. Loses ordinal information for aggregation. Other graders (F2-F10) return continuous [0, 1] primary_score. Fa's binary output breaks cross-fixture bootstrap CI consistency.

**Proposed fix** (line 1628):
```python
# Keep binary primary_pass gate, but make score continuous
primary_score = round(_clamp01(
    (1 - leak) * task_correctness + 0.1 * citation_to_reversal
), 4)
```
Pre-registration note: this changes the numeric scale; if spec lock strictly prohibits, revert and accept information loss. Escalate to orchestrator for a spec amendment decision.

### 🟡 H8. `_extract_labeled_section` is fragile to label-syntax variation

**Where**: `bin/exec-mode-grader.py:822-834`. Used by F7, F9, F10. Matches literal `(a)`, `(b)`, `(c)`. An agent writing `**(a)** Root cause:` works (the parens are present), but `a.` or `a)` or markdown `## a` breaks.

**Impact**: Real agent output has high variance in formatting. F9 and F10 gate their entire primary score on `(a)/(b)/(c)` section extraction; a formatting miss → 0 primary.

**Proposed fix** (line 824):
```python
start_pat = re.compile(
    rf"(?im)(?:^|\n)\s*(?:\*\*)?\(?\s*{re.escape(label)}\s*\)?(?:\.|\:)?(?:\*\*)?",
)
```
And accept trailing `.` or `:` after the letter.

---

## Medium issues (🟢) — nice-to-have improvements

### 🟢 M1. `_regex_any_hit` defined at line 1550, after all F2-F10 callers (lines 910-1547)

Works in Python (late binding at call time) but violates read-order clarity. Move to the helper block near `_safe_div` at `:795`. Also avoids confusion for anyone importing selectively via `from exec_mode_grader import score_f2_invariants` — though since F2 only calls `_regex_any_hit` at runtime, this is academic.

### 🟢 M2. F7 superseded detection uses `DOTALL`, allows cross-document matches

**Where**: `bin/exec-mode-grader.py:1284`:
```python
superseded_full = bool(re.search(
    r"(D2|Turn\s*4).*(supersed|replaced).*(Turn\s*8|D4)",
    text, re.IGNORECASE | re.DOTALL
))
```
With `.DOTALL`, `.*` spans the entire document. An agent mentioning "D2" at the start and "D4" at the end (unrelated) gets a superseded_score of 1.0.

**Fix**: Bound with `[\s\S]{0,200}` or require proximity.

### 🟢 M3. F5 `heading_hits` computed but unused in scoring

**Where**: `bin/exec-mode-grader.py:1140-1143`. The 6 required section headings are checked and reported, but don't gate the primary score. Fixture formula (`F5/ground_truth.json:60-67`) also doesn't tie them to score, but the `section_requirements` exists as a soft structural signal.

**Fix**: Either drop the computation (saves cycles) or wire into score (`score *= heading_hit_ratio`). Decide consistently.

### 🟢 M4. F3 markdown-table parser doesn't validate column count

`_parse_markdown_table_rows` returns any line starting with `|`. Non-tabular pipe lines (e.g., `| some bullet |`) get indexed as `cols[0]..cols[4]`. Low risk since downstream uses `if len(cols) > N` guards.

**Fix**: Optionally filter rows where `len(cols) < 5` for F3 specifically.

### 🟢 M5. F3 test lacks partial-match case (3-of-5 issues found)

`tests/exec-mode/test_grader_f3.py` covers good / bad / empty (3 cases) per spec minimum, but no partial-F1 test to confirm proportional scoring. Add a case where agent finds Critical + 1 High, misses other High + 2 Medium → check precision ≈ 1.0, recall = 0.4 (weighted).

### 🟢 M6. F8 test inherently cannot reveal regex-coupling brittleness (H6)

Tests pass precisely because `GOOD_OUTPUT` is tailored to the narrow regex. Add a test with alternative valid implementation (e.g., `import isEmail from 'validator'; return isEmail(email)`) to expose the false-negative surface.

### 🟢 M7. F7 test `test_score_f7_empty_output_returns_zero` expects `primary_score < 0.2`, not `== 0.0`

Because `no_either` component = 1.0 when output is empty (no Either present), `latest_decision = 0.2` → `score = 0.45*0.2 = 0.09`. That's the current behavior, but "empty output should score 0" is a cleaner contract. Consider zeroing-out when all content checks fail rather than rewarding "no-Either" on empty input.

### 🟢 M8. F6 BAD test doesn't exercise partial-fix case

`tests/exec-mode/test_grader_f6.py` goes good/bad/empty. Add a case where fix is present but `next_step_prediction` is missing → should score `1.0 - 0.05 * 1 = 0.95` (turns_to_success = optimal+1). Confirms the `prediction_ok` branch.

---

## Per-grader assessment

### F2 `score_f2_invariants` — `:910`
- **Spec conformance**: ✅ Invariants preservation rate = matched / total. Threshold 0.875.
- **Ground truth align**: ✅ Reads `invariants_checklist.invariants[*].regex_any_of`, `output_structure_checks`, `past_failure_acknowledgment`. Keys match fixture.
- **Edge cases**: ✅ Empty → 0. Malformed → partial. Over-achievement → clamped.
- **Tests**: 3 cases (good/bad/empty). Minimum coverage met.
- **Findings**: None critical. Clean implementation.

### F3 `score_f3_severity_f1` — `:958`
- **Spec conformance**: ✅ Severity-weighted F1 with FP penalty (`medium_weight`). Formula matches fixture `:77-78`.
- **Ground truth align**: ✅ Handles both `must_cite_line` and `must_cite_line_any_of` correctly (`:981-982`).
- **Edge cases**: ✅ Empty → 0. Distractor flagged → FP penalty. Multi-issue match → correct F1.
- **Tests**: 3 cases. See M5 (add partial).
- **Findings**: Solid. Minor M4, M5.

### F4 `score_f4_oracle_graph` — `:1041`
- **Spec conformance**: ✅ Node + edge match rates with hallucination penalty and mermaid-count hard gate.
- **Ground truth align**: ✅ Reads `oracle_graph.{nodes,node_aliases,edges}`, `output_format_checks.{mermaid_diagram_count_min,ffi_boundary_regex}`.
- **Edge cases**: ⚠️ H4 — short filename refs flagged as hallucinations.
- **Tests**: 3 cases. Good coverage of hallucination + mermaid gate.
- **Findings**: H4 (fix basename comparison).

### F5 `score_f5_citations` — `:1131`
- **Spec conformance**: ❌ C1 (Claude CLI spot-check missing) + C2 (not random).
- **Ground truth align**: ✅ Reads all fixture keys correctly. Word-count bounds + allowlist + blocklist + sources section all wired.
- **Edge cases**: ✅ Empty → 0 with mocked curl. Blocklist stacks correctly (max 3).
- **Tests**: 3 cases + 1 live-network smoke (skip unless `EXEC_MODE_LIVE_NETWORK=1`). Mocking via monkeypatch is clean.
- **Findings**: C1, C2 critical. M3 (unused heading_hits).

### F6 `score_f6_build_turns` — `:1211`
- **Spec conformance**: ⚠️ H5 — text proxy only, no actual build.
- **Ground truth align**: ✅ Reads `stage1_fix_3_checks.*` and `primary_metric.{optimal_remaining_turns,max_turns}`.
- **Edge cases**: ✅ Empty → 0. Anti-pattern (`default=`) → 0 despite correct diff.
- **Tests**: 3 cases.
- **Findings**: H5 (proxy vs real build), M8 (partial-fix test).

### F7 `score_f7_latest_decision` — `:1258`
- **Spec conformance**: ✅ Formula `0.45 * latest + 0.35 * superseded + 0.20 * citation` with `× 0.3` Either penalty matches fixture.
- **Ground truth align**: ✅
- **Edge cases**: ⚠️ H3 (empty banned_pattern false-positive), M7 (empty output scores > 0 via no_either = true).
- **Tests**: 3 cases.
- **Findings**: H3, M2 (DOTALL), M7.

### F8 `score_f8_hidden_tests` — `:1312`
- **Spec conformance**: ⚠️ H6 — heuristic regex stands in for actual test execution.
- **Ground truth align**: ✅ `public_api_required_exports`, `hidden_regression_tests.test_cases[*].kind`, `duplication_reduction_metric.baseline_duplicated_lines`, `test_edit_penalty`.
- **Edge cases**: ✅ Empty → 0. Test-edit detected → 0.3× multiplier.
- **Tests**: 3 cases. Cannot reveal regex brittleness (M6).
- **Findings**: H6 (real test execution), M6 (alt-implementation test).

### F9 `score_f9_root_cause` — `:1412`
- **Spec conformance**: ✅ Formula `0.5 * root + 0.4 * fix + 0.1 * evidence` matches fixture.
- **Ground truth align**: ⚠️ H1 — red herring patterns hardcoded in grader, not fixture.
- **Edge cases**: ✅ Wrong-root-cause → 0. Empty → 0. Partial (cause correct but no turn ref) → 0.5.
- **Tests**: 3 cases.
- **Findings**: H1, H8 (label-section fragility).

### F10 `score_f10_checklist` — `:1487`
- **Spec conformance**: ❌ C3 (turn gate not in spec), ⚠️ H2 (hallucination in primary).
- **Ground truth align**: ✅ Reads all keys, but adds undocumented gate on turn reference.
- **Edge cases**: ✅ Empty → 0.
- **Tests**: 3 cases. Known-good test happens to cite turns, so doesn't expose C3.
- **Findings**: C3, H2, H8.

### Fa `score_fa_false_prior` — `:1563` (reference, pre-existing)
- **Spec conformance**: ✅ Leak + task_correctness + citation match fixture.
- **Ground truth align**: ✅
- **Edge cases**: ✅
- **Tests**: Pre-existing, not in this commit.
- **Findings**: H7 (binary score) — existing, carried forward.

### Dispatch (`PRIMARY_GRADERS` + `score_primary`) — `:1632-1654`
- **Completeness**: ✅ All 10 keys present. `test_primary_graders_registry_has_all_expected_entries` asserts identity.
- **Equivalence**: ✅ `test_score_primary_dispatch_matches_direct_call` verifies `score_primary(fid, out, gt) == direct(out, gt)` for all 10 fixtures.
- **Findings**: Clean.

---

## Strengths (⭐)

1. **Consistent return shape** — every grader returns `{fixture, primary_score, primary_pass, ...components}` dict. Cross-grader analysis will be uniform.
2. **`_clamp01` discipline** — no grader can return >1 or <0 primary_score. Enforced at the edge.
3. **Empty-output graceful degradation** — all 9 new graders tested with `""` → 0 score, no crash.
4. **Dispatch parity test** — `score_primary(fid, out, gt)` equivalence with direct call verified for all 10 fixtures, preventing silent routing bugs.
5. **Mock ground_truth in all tests** — no filesystem dependency; tests are hermetic and fast.
6. **`monkeypatch.setattr(g.subprocess, "run", ...)` pattern for F5** — clean isolation from real network. Live test is env-gated.
7. **Fa preserved** — pre-existing `score_fa_false_prior` untouched except for the second `_regex_any_hit` definition (benign in Python, see M1).
8. **`_judge_cli` infrastructure already exists** (`:327`) with rate-limit + retry + CLI-only pattern — reusing this for C1 fix is cheap.

---

## Recommendation

**Fix C1, C2, C3 before pilot retry.** These are pre-registration breaches — data collected under current implementation cannot be labeled as spec-v3-max.1 results.

**Sequence**:
1. Orchestrator dispatches implementation session (codex or dustcraw-claude) with this review attached.
2. Implementation fixes C1, C2, C3 + reruns `pytest tests/exec-mode/`.
3. Implementation optionally addresses H1-H8 if time permits (each adds real-world robustness; H5+H6 are the largest correctness improvements but require design decisions).
4. M1-M8 can be follow-up issues.
5. After fixes merge, re-tag pre-registration hash (or append `exec-mode-v3-max-preregistered-20260420-fix1`) before pilot retry launches.

**Cost gate**: Pilot retry at 10 seeds × 4 modes × 10 fixtures = 400 trials is expensive. Fix the 3 critical issues first; don't spend budget under broken F5/F10 graders.

**Out of scope for this review**: §5.3 pollution (Layer A+B), §5.4 loss (Layer A+B+C), §5.2 Layer 2 jury (J1-J5), cost parser, compact detection. Those belong to a separate review pass.
