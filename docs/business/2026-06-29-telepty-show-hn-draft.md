# telepty — Show HN / Show GN draft (DRAFT — not for upload until approved)

Strategy basis: narrow hook (AI-CLI orchestration), lead with felt pain, "different layer" is a closing not opening line, preempt "why not tmux?" in the author's own first comment, copy-paste install + 30s aha GIF, pre-answer daemon-security (Mosh tax). Goal = installs.

---

## A. Title (pick one — no adjectives, name the CLIs = self-identifying TAM)

1. **(recommended)** `Show HN: telepty – orchestrate multiple AI CLI sessions (Claude/Codex/Gemini) from one daemon`
2. `Show HN: telepty – drive many AI coding-CLI sessions over an HTTP API, across machines`
3. `Show HN: telepty – spawn, inject into, and broadcast to AI CLI sessions programmatically`

GeekNews (Korean): `telepty – 여러 AI CLI 세션(Claude/Codex/Gemini)을 하나의 데몬에서 오케스트레이션`

---

## B. First comment (author pitch — the highest-leverage element)

> Hi HN. I built telepty because I was running several Claude Code / Codex / Gemini
> sessions at once — spread across tmux panes and two machines — and had no clean way to
> drive them *programmatically*: inject a prompt into one specific session, tell which one
> was idle vs still thinking, or send one instruction to all of them at once.
>
> telepty is a small daemon that wraps any interactive CLI in a PTY and exposes it over
> HTTP/WS: `spawn`, `inject`, `submit`, `read-screen`, `broadcast`/`multicast` — locally or
> across machines over a Tailnet (no sshd).
>
> **It is not a tmux replacement.** tmux *is* the terminal — panes, copy-mode, full VT
> emulation — and it's better at that than telepty will ever be. telepty is the layer that
> lets *software* operate many terminals. The one thing it does that tmux's `send-keys`
> structurally can't: a **readiness-gated submit** — it waits until the target REPL is
> actually ready before pressing Enter, so a prompt injected into a still-booting AI CLI
> doesn't get silently dropped.
>
> Try it (macOS / Linux):
> ```
> curl -fsSL https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.sh | bash
> telepty allow --id a claude
> telepty allow --id b codex
> telepty broadcast "summarize this repo in 3 bullets"
> ```
> [30-second GIF here]
>
> On security: it's a local daemon on :3848, auth-gated (JWT + per-node registration
> tokens); cross-machine calls hit the daemon's HTTP API directly rather than tunnelling
> over SSH. Happy to go into the trust model.
>
> Known limits, up front: **no terminal emulation** — no cell grid / cursor / copy-mode, so
> "read screen" is buffered bytes + heuristic state, not a ground-truth screen; and it needs
> the background daemon running. Windows is supported via the PowerShell installer but gets
> less testing than macOS/Linux.
>
> I'd love feedback — especially from anyone already juggling multiple agent CLIs: how are
> you doing it today?

---

## C. Body / README-derived blurb (if the submission needs a text body)

telepty wraps any interactive terminal program in a PTY bridge and exposes it over an
HTTP/WS/REST API on :3848. Built for AI-CLI workflows (Claude Code, Codex, Gemini CLI) but
works with any REPL. Core verbs: `allow`/`spawn` (wrap a CLI), `inject`/`submit`
(readiness-gated), `read-screen`, `broadcast`/`multicast`, `attach`. Cross-machine session
discovery over Tailnet with `<id>@<host>` addressing — no sshd required.

What it is NOT: a terminal multiplexer. For panes / scrollback / copy-mode, use tmux —
telepty deliberately offloads that to the real terminal. tmux is better at being a terminal;
telepty is better at letting software operate many terminals.

---

## D. Anticipated top comments + prepared replies (post these as needed)

- **"Why not just tmux + send-keys / control-mode?"** → tmux `send-keys` is open-loop (no
  readiness check; injected Enter can drop during boot); control-mode reports terminal/topology
  events, telepty reports inferred agent state (idle/thinking/done) and is reachable over HTTP
  across machines without SSH. Different layer, and they compose — you can telepty-`allow` a CLI
  running inside tmux.
- **"Why not Anthropic Agent View / Codex Desktop?"** → those are first-party, single-vendor
  dashboards. telepty is cross-CLI (Claude + Codex + Gemini + any REPL) and scriptable over an
  open HTTP API, not locked to one vendor's UI.
- **"Security of a daemon on a port?"** → :3848 is auth-gated (JWT + registration tokens);
  bind-local by default; cross-machine is opt-in over your Tailnet.
- **"Node + deps, not lightweight?"** → correct, tmux is the lightweight zero-dep option; telepty
  trades that for the HTTP/automation layer. Use tmux if you don't need that.

---

## E. Launch timing & ops (GeekNews + HN)

- Post weekday morning (09:00–11:00 KST for GeekNews; for HN, ~08:00–10:00 ET weekday).
- Author present + replying for the first 2–3 hours (first-reply speed drives ranking on both).
- Ship the install funnel BEFORE posting: the GIF in README, `curl | bash` one-liner verified
  on a clean machine (macOS + Linux), and one 30-second "aha" command that works on first paste.
- Do not argue with the "why not tmux" wave — concede tmux's strengths, defend only the real gap.
