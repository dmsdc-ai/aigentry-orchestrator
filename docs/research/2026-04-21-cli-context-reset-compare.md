# CLI Context-Reset & Compaction — 3-way Comparison

**Session**: `E-dustcraw-cli-compare` (dustcraw — external research role)
**Date**: 2026-04-21
**Purpose**: Evidence base for Phase 4 **Preuse** (Persistent-Reuse) exec-mode scope decision.
**Scope**: Claude Code, Codex CLI, Gemini CLI — equivalent features for `/clear` (context reset) and `/compact` (context compaction).
**Constraints**: Read-only research. Evidence-cited. All findings sourced from official docs, upstream issues, or primary CLI `--help` output. Unknowns explicitly marked.

---

## 1. Executive summary

| Capability | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| **Context reset (`/clear` equivalent)** | `/clear` — full context wipe, session process preserved | `/clear` — new conversation in same CLI session; also `/new` | `/clear` — **display-only** (terminal scrollback clear; underlying session data may persist). Not a true context reset. |
| **Context compaction (`/compact` equivalent)** | `/compact [instructions]` — manual summarize; `/rewind` can "Summarize from here" (partial) | `/compact` — manual summarize visible conversation | `/compress` — manual replace-with-summary |
| **Auto-compact trigger** | Yes (built-in) | Yes (built-in, threshold-based) | Yes (since v0.11.3 default ON, configurable) |
| **Auto-trigger threshold** | ~95% context capacity (user-visible); buffer ~33K tokens (16.5%) per 3rd-party analysis. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var overrides | `effective_window − 13,000 tokens` where `effective_window = model_context_window − min(max_output_tokens, 20,000)`. Configurable `threshold_tokens`; v0.100.0+ hard 90% clamp | `model.chatCompression.contextPercentageThreshold` in `settings.json`; default was 0.7, **changed to 0.2 in v0.11.3** |
| **Session process preserved across reset?** | Yes | Yes | Yes (clear = display; compress = context rewrite) |
| **Partial / scoped compaction** | Yes — `/compact <instructions>` and `/rewind` → "Summarize from here" | No (full visible conversation only) | No (replaces entire chat context) |
| **Checkpoint / rewind** | Yes (`/rewind`, `Esc+Esc`) — before every Claude action | Yes (`/fork` clones thread); no per-action checkpoint | Yes (manual `/chat save <tag>` + `/chat resume <tag>`) |
| **Side-question overlay (no context impact)** | Yes (`/btw`) | Partial (`/side` conversations) | Unknown — needs confirmation |
| **Reported regressions (as of 2026-04)** | Auto-compact quality varies Opus vs Sonnet; tool-heavy sessions trigger sooner | CLI v0.118: ~2× more frequent compactions; v0.100.0 hard 90% clamp silently overrides user config | `/compress` can fail with `maxOutputTokens` error when auto-model-switch triggers overflow |

**Bottom line for Preuse**: **All three CLIs expose manual slash-command-style context compaction + reset, and all three now support auto-compaction triggered by threshold.** A cross-CLI Preuse adapter is **feasible** with per-CLI trigger command mapping + per-CLI threshold semantics.

---

## 2. Claude Code — `/clear` and `/compact`

### 2.1 `/clear`
- **Source**: [Best Practices for Claude Code — code.claude.com](https://code.claude.com/docs/en/best-practices) (official).
- **Semantics**: "Reset context between unrelated tasks. Long sessions with irrelevant context can reduce performance." Full wipe — previous messages/file-reads are discarded.
- **Session process**: Preserved. Same `claude` process; same CWD; same loaded CLAUDE.md / skills.
- **Cost**: 0 tokens (local state reset — no API call).
- **Availability**: Any time during interactive session.

### 2.2 `/compact`
- **Source**: same official docs + third-party deep-dives ([MindStudio](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management), [ClaudeLog](https://claudelog.com/faqs/what-is-claude-code-auto-compact/), [claudefa.st](https://claudefa.st/blog/guide/mechanics/context-buffer-management)).
- **Semantics**: Summarize conversation → replace history with condensed summary preserving "code patterns, file states, and key decisions." Costs one summarization API call.
- **Scoped variant**: `/compact <instructions>` accepts free-text instructions (e.g., `/compact Focus on the API changes`).
- **Partial compaction**: `Esc+Esc` or `/rewind` → select message → **Summarize from here**. Condenses from that point forward, earlier context intact.
- **CLAUDE.md override**: per official docs, you can add `"When compacting, always preserve the full list of modified files and any test commands"` to influence behavior.

### 2.3 Auto-compact
- **Official**: "Claude Code automatically compacts conversation history when you approach context limits" — but **no exact threshold published in official docs**.
- **Third-party observations**:
  - ClaudeLog: ~95% capacity.
  - claudefa.st: buffer reduced to ~33K tokens (16.5%) as of 2026, giving ~12K more usable space.
  - Threshold varies by model (Opus triggers earlier than Sonnet) and by tool-call density (tool-heavy sessions trigger sooner).
- **Env override**: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (per claudefa.st).

### 2.4 Complementary features (unique to Claude Code)
- `/btw` — side question in overlay, **never enters context**.
- `/rewind` — checkpoint-based time travel (before every Claude action).
- `claude --continue` / `--resume` — cross-session persistence.
- Subagents — run in separate context windows (offload research without consuming main context).

---

## 3. Codex CLI — `/clear` and `/compact`

### 3.1 `/clear`
- **Source**: [OpenAI Codex CLI Slash Commands](https://developers.openai.com/codex/cli/slash-commands) (official).
- **Semantics**: "Clear the terminal and start a fresh chat" — resets UI **AND** conversation together. Unlike `Ctrl+L` (view-only clear), `/clear` starts a new conversation.
- **Availability**: **Unavailable while tasks are in progress.** Must wait for current turn to finish.
- **Session process**: Preserved.

### 3.2 `/new`
- Start a new conversation in same CLI session **without** clearing the terminal view.
- Useful when you want to preserve scrollback as reference but reset context.

### 3.3 `/compact`
- **Official behavior**: Manual. "Summarize visible conversation to free tokens. Replaces earlier turns with concise summaries." Codex offers a preview / confirmation before applying.
- **Queued during tasks**: Type `/compact` + `Tab` to queue for next turn.
- **Official docs state no auto-threshold** — but issue tracker and community confirm auto-compact IS built in (see 3.4).

### 3.4 Auto-compact (from issue tracker + 3rd-party research)
- **Source**: [openai/codex Issue #4106](https://github.com/openai/codex/issues/4106), [Issue #11805](https://github.com/openai/codex/issues/11805), [Issue #16068](https://github.com/openai/codex/issues/16068), [Issue #16812](https://github.com/openai/codex/issues/16812), [context compaction gist](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f).
- **Threshold formula (current)**: `effective_context_window − 13,000 tokens`, where `effective_context_window = model_context_window − min(max_output_tokens, 20,000)`.
- **Configurable**: `threshold_tokens` per-model (e.g., `240000` for GPT-5 class). User can also set `mode = "off"` to disable.
- **v0.100.0+ regression**: hard 90% clamp silently overrides higher user-defined thresholds (Issue #11805).
- **Fallback**: If compression insufficient, Codex does **head-trimming** (drops oldest messages).
- **v0.118 regression (open as of 2026-04)**: Compaction fires ~2× more frequently vs v0.116, causing cascading re-reads (Issue #16812).

### 3.5 Other relevant slash commands
- `/fork` — clone current conversation into new thread with fresh ID. Original transcript untouched.
- `/resume` — pick from session list, reload transcript.
- `/side` — side conversations for quick questions.
- `/model`, `/fast`, `/personality`, `/permissions`, `/agent`, `/status` — runtime steering.

---

## 4. Gemini CLI — `/clear` and `/compress`

### 4.1 `/clear` — **NOT** equivalent to Claude/Codex `/clear`
- **Source**: [Gemini CLI Commands (official)](https://google-gemini.github.io/gemini-cli/docs/cli/commands.html), cross-check [geminicli.com docs](https://geminicli.com/docs/reference/commands/).
- **Semantics**: "Clear the terminal screen, including the visible session history and scrollback within the CLI. **The underlying session data (for history recall) might be preserved.**"
- **Keyboard shortcut**: `Ctrl+L` (same binding as display-clear, **not** a context reset).
- **⚠️ Gotcha**: If `Preuse-clear` is intended to reset context, Gemini `/clear` **does not do that**. Use `/compress` (see 4.2) or a new session for true context reset.

### 4.2 `/compress`
- **Source**: same as 4.1.
- **Semantics**: "Replace the entire chat context with a summary." Saves tokens while retaining high-level summary of what happened.
- **Manual trigger**: Yes.
- **Auto-trigger**: Yes (see 4.3).

### 4.3 Auto-compress
- **Source**: [Chat Compression and Context Management (DeepWiki)](https://deepwiki.com/google-gemini/gemini-cli/4.12-chat-compression-and-context-management), [Issue #12068](https://github.com/google-gemini/gemini-cli/issues/12068), [v0.11.3 release notes inferred from issues].
- **Configuration key**: `model.chatCompression.contextPercentageThreshold` in `settings.json`.
- **Default**: **Changed from 0.7 → 0.2 in v0.11.3** (20% of max context window).
- **Value range**: 0.0 – 1.0 (fraction of model context window).
- **Strategy**: "Split history, summarize the head (oldest parts), prepend summary to the tail (preserved recent parts)."
- **Known failure mode** ([Issue #8609](https://github.com/google-gemini/gemini-cli/issues/8609), [#4442](https://github.com/google-gemini/gemini-cli/issues/4442)): When auto-model-switch occurs (e.g., Gemini 1.5 Pro → 1.0 Pro), `/compress` can fail with `maxOutputTokens` exceeded.

### 4.4 Session / checkpoint commands
- `/chat save <tag>` — manual checkpoint.
- `/chat resume <tag>` — restore checkpoint.
- `/chat list` / `/chat delete <tag>` / `/chat share [filename]`.
- Storage: `~/.gemini/tmp/<project_hash>/` (Linux/macOS).
- CLI flags: `--resume <tag-or-index>`, `--list-sessions`, `--delete-session <idx>`.

### 4.5 `/memory` (hierarchical context management)
- Manages instructional context from `GEMINI.md` files.
- Subcommands: `add`, `show`, `refresh`, `list`.
- **Not** a context-reset tool — manages persistent instructions, not transient conversation.

---

## 5. Realistic trigger timing — user patterns

### 5.1 Manual-trigger timing (common patterns observed across CLIs)
1. **Task boundary**: user finishes a discrete sub-task, types `/clear` or `/compact` before next task. **Most disciplined users do this.**
2. **Reactive (late)**: user hits degraded output, realizes context is polluted, then clears. Usually too late — output quality already suffered.
3. **Pre-emptive (token-counter watch)**: user with custom status line watches token %, manually compacts around 50–70%. Requires user vigilance.
4. **Post-failure**: after 2+ failed corrections, `/clear` and restart with a better prompt (explicitly recommended by Claude Code best-practices doc).

### 5.2 Auto-trigger defaults (as of 2026-04)
| CLI | Default auto-trigger point | Aggressiveness |
|---|---|---|
| Claude Code | ~95% (inferred); ~33K-token buffer | **Conservative** — late, preserves working context |
| Codex CLI | ~ (context − 13K − 20K) tokens | **Moderate** — model-dependent absolute; recent v0.118 regression = 2× more frequent |
| Gemini CLI | 20% (v0.11.3 default) | **Aggressive** — fires very early; user-configurable up to 1.0 |

### 5.3 Realistic trigger definition (synthesized)
Based on cross-CLI evidence, a "realistic" Preuse trigger for aigentry exec-mode experiments should:
- **Default to task-boundary semantics**, not percentage watchdog. Users hit `/clear` between unrelated tasks — this is the dominant real pattern.
- **If percentage-based**: 60–70% is the "safe" manual trigger; 20–30% (Gemini default) is likely too aggressive for benchmarking; 95% (Claude auto-default) is too late for experiment purposes because quality has already degraded.
- **Preuse-compact**: mimic `/compact` semantics — measure summarization token cost + post-compact accuracy retention.
- **Preuse-clear**: mimic `/clear` semantics — measure spin-up cost of re-loading CLAUDE.md / skills / project context.

---

## 6. Preuse mode scope — recommendation

### 6.1 Recommendation: **Cross-CLI with per-CLI adapter**

Rationale:
- All 3 CLIs expose the required capabilities (context reset + compaction, manual + auto).
- aigentry constitution §2 (Cross-Everything) requires cross-CLI experience parity — Claude-only scope would violate.
- Slash-command names differ (`/clear` vs `/compress` for Gemini context-reset equivalent) — adapter layer must translate.

### 6.2 Adapter requirements
| aigentry Preuse operation | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| `preuse.clear` (reset context, keep session) | `/clear` | `/clear` | **`/compress`** (NOT `/clear` — that's display-only) OR new session |
| `preuse.compact` (summarize, keep session) | `/compact` | `/compact` | `/compress` |
| `preuse.compact <focus>` | `/compact <focus>` | `/compact` (no focus arg) | `/compress` (no focus arg) |
| `preuse.rewind` (partial summarize) | `/rewind` → Summarize from here | `/fork` (clone only, not rewind) | Not supported |

### 6.3 Caveats — Gemini CLI
- **`/clear` trap**: Gemini `/clear` is display-only. If the aigentry orchestrator naively sends `/clear` expecting context reset, Gemini will silently not reset context. Adapter must remap `preuse.clear` → `/compress` OR spawn new session.
- **`/compress` failure mode**: known issue #8609 when model auto-switches. Adapter must either pin model or handle the error.

### 6.4 Caveats — Codex CLI
- `/clear` **unavailable during running task** — adapter must wait for turn completion before sending.
- v0.118 auto-compact regression — pin to v0.116 or later stable for reproducible benchmarks.

### 6.5 Caveats — Claude Code
- Auto-compact threshold not officially documented; 3rd-party says ~95%. For Preuse experiments, suggest **explicitly disabling auto-compact** (via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, if supported per-session) and driving compaction manually for reproducibility.
- If env override not supported, document auto-compact as an uncontrolled variable.

---

## 7. Phase 4 Preuse trigger design — proposal

### 7.1 Trigger taxonomy

Three trigger modes — benchmark each:

1. **`preuse.task-boundary`** (recommended default)
   - Fire at end of each logical task (aigentry task-queue boundary).
   - Matches dominant user pattern.
   - Clean, deterministic, reproducible.

2. **`preuse.percentage`** (configurable threshold)
   - Fire when conversation tokens exceed `N%` of model context window.
   - Recommended range: 60–70% for experiments (neither too late nor too aggressive).
   - Cross-CLI: requires CLI-specific token accounting (Claude status line, Codex token counter, Gemini `/stats`).

3. **`preuse.fixed-turns`** (every N turns)
   - Fire every N turns (e.g., N=20).
   - Simplest to implement cross-CLI, no token-counting adapter needed.
   - Less principled but useful as a baseline.

### 7.2 Operation selection (clear vs compact)

Per Preuse experiment spec:
- **Preuse-clear** variant: fire `preuse.clear` (Claude `/clear`, Codex `/clear`, Gemini new-session).
- **Preuse-compact** variant: fire `preuse.compact` (Claude `/compact`, Codex `/compact`, Gemini `/compress`).
- Benchmark both; compare:
  - Token cost (compact = 1 summary call; clear = 0).
  - Accuracy / task-completion-rate after operation.
  - Spin-up cost (CLAUDE.md / skills / MCP server re-load — matters especially for clear).

### 7.3 Cross-CLI instrumentation needs

- **Per-CLI session adapter** (telepty or equivalent) must:
  - Know which slash command maps to `preuse.clear` / `preuse.compact` for that CLI.
  - Detect "unavailable during task" (Codex) — queue or defer.
  - Capture token counter before/after for cost accounting.
  - Capture wall-clock time for spin-up measurement.

---

## 8. Open questions / uncertainties

1. **Claude Code exact auto-compact threshold** — official docs say "approaches context limits" without number. 95% is 3rd-party inference. Confirm with Anthropic if exact value matters for Preuse variance bounds. → **action**: test empirically or file question with Anthropic.

2. **Codex `threshold_tokens` behavior with model_context_window** — Issue #16068 reports `model_context_window` + `fill_to_context_window` resets token counter, breaking auto-compaction. Needs verification on target Codex version.

3. **Gemini `/clear` context-reset behavior** — docs say "underlying session data *might be* preserved." Ambiguous. Test empirically: send `/clear` then ask about prior turn content.

4. **Token counter availability cross-CLI** — Claude has status line + `/btw`; Codex has `/status`; Gemini has unknown equivalent. Adapter needs uniform token-counting primitive.

5. **Partial / scoped compaction** — only Claude Code supports `/compact <instructions>` + `/rewind`-based partial summary. If Preuse depends on scoped compaction, that's **Claude-only** and violates §2 Cross-Everything. If experiment doesn't require it, this is moot.

6. **CLAUDE.md / GEMINI.md / AGENTS.md re-load cost on clear** — after `/clear`, does each CLI re-inject the instructions file? Needs empirical test to quantify Preuse-clear spin-up cost.

7. **Skills / subagents persistence** — Claude Code skills persist across `/clear` (they load on demand). Codex plugins? Gemini extensions? Need verification.

8. **Codex `/clear` vs `/new` for aigentry Preuse** — `/new` preserves scrollback, `/clear` resets UI + conversation. Which matches aigentry's intended semantics better? **Suggest `/new`** if the orchestrator wants to preserve transcript for later reference.

9. **Auto-compact disablement for experimental control** — confirm each CLI allows disabling auto-compact:
   - Claude Code: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=100` (3rd-party claim — verify).
   - Codex CLI: `threshold_tokens` + `mode = "off"` (confirmed via Issue #4106).
   - Gemini CLI: `model.chatCompression.contextPercentageThreshold = 1.0` (infer — verify).

10. **Deliberation / inter-session effects** — if Preuse fires mid-deliberation, how do other sessions react? Out of scope for this research but flag for Phase 4 design review.

---

## Sources

Primary / official:
- [Claude Code — Best Practices](https://code.claude.com/docs/en/best-practices)
- [OpenAI Codex CLI — Slash Commands](https://developers.openai.com/codex/cli/slash-commands)
- [OpenAI Codex CLI — CLI Reference](https://developers.openai.com/codex/cli/reference)
- [Gemini CLI — Commands (google-gemini.github.io)](https://google-gemini.github.io/gemini-cli/docs/cli/commands.html)
- [Gemini CLI — Commands Reference (geminicli.com)](https://geminicli.com/docs/reference/commands/)

Upstream issues (evidence for auto-trigger thresholds / regressions):
- [openai/codex#4106 — Control over auto-compaction parameters](https://github.com/openai/codex/issues/4106)
- [openai/codex#11805 — v0.100.0 hard 90% clamp nullifies user threshold](https://github.com/openai/codex/issues/11805)
- [openai/codex#16068 — model_context_window breaks auto-compaction](https://github.com/openai/codex/issues/16068)
- [openai/codex#16812 — v0.118 2× more frequent compactions](https://github.com/openai/codex/issues/16812)
- [google-gemini/gemini-cli#12068 — COMPRESSION_TOKEN_THRESHOLD=0.7→0.2 rationale](https://github.com/google-gemini/gemini-cli/issues/12068)
- [google-gemini/gemini-cli#8609 — /compress fails with maxOutputTokens after auto-switch](https://github.com/google-gemini/gemini-cli/issues/8609)
- [google-gemini/gemini-cli#4442 — Compression Error](https://github.com/google-gemini/gemini-cli/issues/4442)

Third-party analyses (cited with attribution):
- [Context Compaction Research gist — badlogic](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [ClaudeLog — Auto-Compact FAQ](https://claudelog.com/faqs/what-is-claude-code-auto-compact/)
- [claudefa.st — Context Buffer Management](https://claudefa.st/blog/guide/mechanics/context-buffer-management)
- [MindStudio — /compact Command](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management)
- [DeepWiki — Gemini CLI Chat Compression](https://deepwiki.com/google-gemini/gemini-cli/4.12-chat-compression-and-context-management)
- [Managing Your Context Window: Clear vs. Compact — Medium](https://medium.com/@nustianrwp/managing-your-context-window-clear-vs-compact-in-claude-code-8b00ae2ed91b)
- [Shedding Heavy Memories (Justin3go)](https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode)

Local CLI `--help` output captured during research:
- `claude --help` (Claude Code CLI, installed via cmux bundle)
- `codex --help` (Codex CLI v0.x, Homebrew)
- `gemini --help` (Gemini CLI, nvm node v20.20.0)
