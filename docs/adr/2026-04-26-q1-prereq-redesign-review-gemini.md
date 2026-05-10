# Q1 ADR Reviewer 2 — Gemini (cross-CLI implications)

## 1. Verdict & Summary
**Verdict: ACCEPT-IF**

Option A's `-p`+rebuild semantic is largely portable, but it requires an explicit adapter layer to abstract CLI-specific differences. Gemini CLI directly supports the required `-p` and `--resume` non-interactive primitives natively, mirroring Claude Code. Codex CLI requires subcommand routing (`exec` and `resume`) and lacks an identical unified non-interactive flag pair. Because the architect's summarizer is harness-internal and deterministic, the prompt parsing itself is entirely portable across all CLIs. However, token-counting parity remains a blocker for strict cross-CLI benchmarking.

## 2. Per-Criterion Findings

1. **Codex `-p`+rebuild equivalent:** Codex does not have an identical `-p` flag. It provides non-interactive execution via the `codex exec` subcommand and session resumption via the `codex resume` subcommand. Combining these for a drop-resume semantic requires harness orchestration rather than a single CLI flag execution. (Evidence: `codex --help` output).
2. **Gemini `-p`+rebuild equivalent:** Gemini CLI (v0.39.1) perfectly mirrors the required primitive. It provides `-p, --prompt` for headless non-interactive mode and `-r, --resume <tag>` for session resumption, plus `-o stream-json` for output formatting. (Evidence: `gemini --help` output).
3. **Substitute-compact prompt portability:** Yes, the prompt format is highly portable. Because the architect's summarizer is deterministic and internal to the trial harness, it simply feeds a standard text/markdown payload (system + history summary + new task) to the CLI via stdin or prompt arguments. All three CLIs parse standard text equivalently without breaking on CLI-specific delimiters. (Evidence: ADR 2026-04-26-q1-prereq-redesign.md M1 findings confirm the harness uses standard `setup_history.md` + `task_prompt.md` files).
4. **Token-counting parity (Q4 link):** Parity is currently broken/unverified. Claude uses a status line + `/btw`, Codex relies on `/status` or its internal `effective_context_window` logic, and Gemini's token-counting primitive is unknown to the adapter. A "cut" of 100k tokens means different things if the encoder and counting base (cumulative transcript vs user-only) differ. (Evidence: `2026-04-21-cli-context-reset-compare.md` §7.3 and §8.4).
5. **Layer 1 vs Layer 2 placement:** Option A's primitive should be promoted as **Layer 2 (cross-CLI portable)**. While the raw `claude -p` invocation is technically Layer 1, the abstract `preuse.compact` operation requires a "cross-CLI with per-CLI adapter" per `2026-04-21-cli-context-reset-compare.md` §6.1 to fulfill the Rule 4-0 §2 cross-everything mandate.
6. **Phase 5 holdout-fixture cross-CLI risk:** There is zero cross-CLI risk for Phase 5. Phase 5 remains strictly "Claude-only agents" per Rule 4-0 Narrow Lock. The lock is only lifted after Phase 4 and Phase 5 are successfully completed. (Evidence: `2026-04-22-rule-4-mode-selection.md` §2.1 and §5).

## 3. Per-CLI Portability Table

| CLI | `-p` flag | `--resume` equiv | drop-resume primitive | summarizer parse | token-count base | can-Phase-5-run |
|---|---|---|---|---|---|---|
| **Claude** | Yes (`--print`) | Yes (`--resume`) | Yes (native) | Yes | Status line | Yes |
| **Codex** | No (`exec` cmd) | Yes (`resume` cmd) | Needs adapter | Yes | `/status` | No (Claude-only) |
| **Gemini** | Yes (`--prompt`) | Yes (`--resume`) | Yes (native) | Yes | Unknown | No (Claude-only) |

## 4. Recommendation on Layer Placement
**Recommend: Layer 2**. The abstract concept of `preuse-substitute-compact` must live in Layer 2 to satisfy the ecosystem's cross-everything mandate (Rule 4-A). The Orchestrator (Layer 2) must mediate this via the per-CLI session adapter to handle the translation between `claude -p`, `gemini -p`, and Codex's command-based execution, resolving CLI-specific token and session state nuances.

## 5. Conditions for ACCEPT (ACCEPT-IF)
The architect must make the following additions to the ADR:
1. Add a section explicitly declaring that the abstract `preuse-substitute-compact` semantic belongs to Layer 2, governed by an adapter, to prevent Layer 1 assumption bleed.
2. Acknowledge that while Gemini supports the `-p` + `--resume` primitive natively, Codex requires adapter-level command translation.
3. Document that token-counting parity is an uncontrolled variable across CLIs until a uniform adapter primitive is implemented.

## 6. Iter-2 Re-Review (2026-04-26)

**Verdict: ACCEPT**

The architect has successfully applied the three requested cross-everything changes (G1-G3). Section 4.7.1 correctly places the `preuse-substitute-compact` operation in Layer 2, with explicit bounds making Phase 4+5 a Claude-only stub so as not to impose immediate Phase 4 work. The per-CLI adapter table in §4.7.2 accurately reflects the subcommand routing needed for Codex vs the native flags for Claude and Gemini (v0.39.1), unifying them under the `cli_invoke(prompt, resume=None)` signature. Finally, §7.4 properly caveats token-counting parity as an uncontrolled variable that blocks Phase 6+ cross-CLI extension until Q4 is resolved, ensuring no false assumptions of equivalence are carried into Phase 4+5.
