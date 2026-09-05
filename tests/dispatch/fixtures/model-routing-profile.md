---
measured_at: 2026-09-05
models:
  - {label: fable-5.1, cli: claude, model: "claude-fable-5-1[1m]"}
  - {label: gpt-6-astra, cli: codex, model: "gpt-6-astra"}
  - {label: grok-4.6, cli: grok, model: "grok-4.6"}
  - {label: gemini, cli: gemini, model: "gemini-3.8-flash-high"}
default_table: { architect: fable-5.1, analyst: fable-5.1, researcher: gemini, coder: gpt-6-astra, tester: gpt-6-astra, builder: gpt-6-astra, logger: grok-4.6 }
---
Fixture only: route implementation to Astra, research to Gemini, logging to Grok,
and architecture/analysis to Fable. PROFILE-BODY-T138
