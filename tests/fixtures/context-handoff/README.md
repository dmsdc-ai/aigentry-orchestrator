# Context-handoff schema fixtures (task 1201)

Synthetic transcripts for `tests/context-handoff/*.test.ts` and
`tests/dispatch/T135_orchestrator_boot_handoff.sh`. Every **shape** (file layout, record
types, key paths) comes from the Phase 0 measurement of the four native stores on the
owner's machine (2026-10-09, key paths and types only, no values). Every **value** is
synthetic. No byte here was copied from a real transcript.

| Dir | Store it stands for | Measurement |
|---|---|---|
| `claude/` | `~/.claude/projects/<cwd-slug>/<session>.jsonl` (+ `<session>/subagents/*.jsonl`) | P0-1 (claude 2.1.283), SPEC §2.1 |
| `codex/` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl` | P0-2 |
| `gemini/` | `~/.gemini/projects.json` + `~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl` | P0-3 |
| `grok/` | `~/.grok/sessions/<url-encoded cwd>/<session>/{chat_history,prompt_history}.jsonl`, `prompt_context.json`, `system_prompt.txt` | P0-4 |
| `agy/` | `~/.gemini/antigravity/conversations/<uuid>.pb` — protobuf, detect-only (newest mtime) | P0-3 |

Not measured, and therefore chosen here (a change in the real store breaks the matching test,
not the product silently):

- `gemini/projects.json` is written as `{"projects": {"<cwd>": "<project name>"}}`. Phase 0
  recorded only "maps cwd → project name".
- gemini model replies use `type: "gemini"` (Phase 0 lists `user | …`).
- grok `prompt_history.jsonl` `timestamp` is an ISO string (Phase 0 lists the key only).
- codex `world_state` / `token_usage_record` payload keys are invented; only the record types
  were measured.

Placeholders, replaced when a test plants a fixture (`tests/context-handoff/harness.ts`):

- `__WORKSPACE__` — the fixture workspace's realpath (JSON-escaped).
- `__SESSION__` — the session id the test chooses.
- `__PROJECT__` — the gemini project name.

Every ISO timestamp is shifted by one offset when planted, so a test can make any fixture the
newest while keeping its internal order.

Marker convention: `CH-<CLI>-…` strings are content the handoff is expected to carry;
`CANARY-<CLI>-…` strings sit in fields the handoff must never copy (reasoning, tool output,
raw tool input, attachments, system/developer text, sidechains, subagents).

Regenerating: the fixtures were produced by a one-off generator kept outside the repo (it
is not shipped). Edit the files directly; keep each line one JSON record.
