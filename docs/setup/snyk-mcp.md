# Snyk MCP — install + scan workflow

**Status**: installed at user scope (`~/.claude.json`), MCP health green, **auth pending (user action — see one-paste quickstart below)**.
**Mandate**: `~/.claude/CLAUDE.md` global rule — *Snyk Security At Inception* — applied at **commit / PR time on first-party code in Snyk-supported languages** (not blanket release-time). Orchestrator AGENTS.md delegation checklist row enforces the dispatch-time inject. Release-time policy (since-last-release first-party change accounting) is a **separate** open decision and out of scope here.

---

## One-paste OAuth quickstart (run once per machine)

```bash
npm install -g snyk && snyk auth && snyk whoami && echo "✓ Snyk ready"
```

What happens, in order:

1. `npm install -g snyk` — installs the Snyk CLI globally (≈ 30 s on a fresh machine).
2. `snyk auth` — opens your default browser to `https://app.snyk.io/login/cli` (or prints a URL to paste). Approve the device. The CLI then prints something like `Your account has been authenticated. Snyk is now ready to be used.`
3. `snyk whoami` — should print your Snyk account name / username (e.g., `dmsdc-ai`). This is the canonical post-OAuth probe. **Do not use `snyk config get api`** as a verification — it returns blank under the OAuth flow used since CLI ≥ 1.1293 (OAuth credentials live in the CLI's own keystore, not the legacy `configstore/snyk.json` API-token file). `snyk config get api` is only meaningful for the token-mode flow (Step 2-alt).
4. `echo "✓ Snyk ready"` — only prints if the preceding commands all exit 0.

If you are in a headless / no-browser environment, skip the oneliner and use the **token fallback** (Step 2-alt below).

---

## What this enables

After `snyk auth`, every Claude Code session inherits the `snyk` MCP server and exposes 12 Snyk tools. The directly relevant one for the global rule is:

- `snyk_code_scan` — SAST (Static Application Security Testing) on newly written / modified first-party code.

Other registered tools: `snyk_sca_scan`, `snyk_iac_scan`, `snyk_container_scan`, `snyk_sbom_scan`, `snyk_secret_scan` (experimental), `snyk_aibom`, `snyk_package_health_check`, `snyk_trust`, `snyk_auth`, `snyk_logout`, `snyk_auth_status`, `snyk_version`.

## Why this package (Article 17 — 무의존, official-first)

Official sources (no third-party wrappers):

- Snyk MCP server is shipped **inside the Snyk CLI** (`snyk mcp` subcommand). Repo: [`snyk/studio-mcp`](https://github.com/snyk/studio-mcp).
- Anthropic MCP Marketplace manifest: [`snyk/agentic-integration-wrappers`](https://github.com/snyk/agentic-integration-wrappers) (`server.json`, MCP name `io.snyk/mcp`, npm package `snyk`, transport `stdio`, args `mcp -t stdio`).
- No standalone `snyk-mcp` / `@snyk/mcp-server` npm package exists (verified `npm view` → 404). All other `*-snyk-mcp` repos on GitHub are third-party / archived and are rejected per Article 17.

## Install (already done — for reproducibility)

```bash
# 1. Snyk CLI globally (host-level dev tool, NOT a runtime dep of any project)
npm install -g snyk

# 2. Register MCP server at *user* scope so every Claude Code session inherits it
claude mcp add snyk -s user -- snyk mcp -t stdio

# 3. Verify
claude mcp list | grep -E '^snyk:'
# Expected: snyk: snyk mcp -t stdio - ✓ Connected
```

## Auth — 3-step OAuth (USER ACTION REQUIRED)

The Snyk CLI scans require an authenticated Snyk account. Until this is done, `snyk_code_scan` and friends will fail with `authentication required` / `User not authenticated`.

### Step 1 — install (if not done by the oneliner above)

```bash
npm install -g snyk
```

Expected on success: `added 1 package in <N>s` (npm), `snyk` available on `$PATH`. Verify:

```bash
which snyk && snyk --version
# Expected: /usr/local/bin/snyk (or your npm-global bin)
# Expected: a semver like 1.1370.0 (or newer)
```

### Step 2 — OAuth (browser flow, default since CLI ≥ 1.1293)

```bash
snyk auth
```

Expected sequence:

1. CLI prints something like:
   ```
   Now redirecting you to our auth page, go ahead and log in,
   and once the auth is complete, return to this prompt and you'll
   be ready to start using snyk.
   If you can't wait use this url:
   https://snyk.io/login?token=<uuid>&utm_medium=cli...
   ```
2. Browser opens automatically. Log in with your Snyk account (free tier is sufficient for personal / OSS use; check pricing if commercial).
3. Browser shows "Authenticated! You can close this window." The CLI then prints:
   ```
   Your account has been authenticated. Snyk is now ready to be used.
   ```

### Step 2-alt — token fallback (CI / headless / OAuth-stuck environments)

If browser OAuth is not possible (no display, port busy, corporate firewall, etc.):

1. Generate a token at <https://app.snyk.io/account> → "Auth Token" → click to reveal.
2. Authenticate with the token:
   ```bash
   snyk auth <SNYK_API_TOKEN> --auth-type=token
   # or, for a single shell session:
   export SNYK_TOKEN=<SNYK_API_TOKEN>
   ```

The token method writes the same `~/Library/Application Support/configstore/snyk.json` (or `~/.config/configstore/snyk.json` on Linux) as the OAuth flow.

### Step 3 — verify

```bash
# Canonical post-OAuth probe (works for both OAuth and token modes):
snyk whoami
# Expected: your Snyk account name / username (e.g. dmsdc-ai), exit 0.

# Token-mode-only probe (OAuth returns blank here — DO NOT use as OAuth verification):
snyk config get api
# Expected (token mode): a UUID. (OAuth mode): blank — that is normal.
```

If `snyk whoami` fails with `not authenticated` or non-zero exit, auth did **not** complete (browser was closed early, network drop, port-busy fallback failed). Re-run Step 2 or use Step 2-alt.

**Free tier limits**: 100 SAST tests/month (Snyk Code), 200 open-source tests/month. Enough for personal / OSS work; for the orchestrator project's commit cadence this is adequate. Upgrade only if rate-limited.

## CLI-only quickstart (MCP unavailable in your session)

Some sessions are spawned without an MCP host (e.g., orchestrator-dispatched coder sessions that talk to telepty directly, pre-commit hooks, CI runners, raw `bash` over SSH). For those, use the shell wrapper instead:

```bash
# In any aigentry-* repo that has scaffolded bin/snyk-scan.sh:
bin/snyk-scan.sh                 # scan files changed in HEAD vs HEAD~1
bin/snyk-scan.sh HEAD~3..HEAD    # scan a git range
bin/snyk-scan.sh --all           # full-repo scan
bin/snyk-scan.sh --help          # usage block
```

Exit codes: `0` = no issues, `1` = issues found (forward Snyk findings), `2` = CLI / auth missing (run the OAuth quickstart above).

The script auto-detects changed files via `git diff --name-only` and invokes `snyk code test <dir>` once per unique parent directory (caps at repo root if any change is at root).

**Propagation**: `bin/snyk-scan.sh` is bundled into every aigentry-* repo via `aigentry-devkit` scaffold templates. Running `npx @dmsdc-ai/aigentry-devkit scaffold --project <cwd> --cli <claude|codex|gemini>` lands the script at `0o755` automatically (task #130 / 2026-05-17).

## Scan workflow — "snyk_code_scan after new code commits"

Per global CLAUDE.md rule + AGENTS.md delegation checklist:

1. **Trigger**: a delegated coder session has produced / modified first-party code in a Snyk-supported language (TS/JS, Python, Go, Java, Rust, C/C++, C#, PHP, Ruby, Kotlin, Swift, etc.) — i.e., the **At-Inception** moment, before the DONE report.
2. **Scope**: prefer scoping the scan to changed files. Default tool call (within an MCP-enabled Claude session):

   ```text
   snyk_code_scan path=/abs/path/to/project
   ```

   For a narrower scope, pass a subdirectory or a specific file path.
3. **Result handling**:
   - 0 issues → done.
   - Issues found → attempt to fix using Snyk's result context, re-run `snyk_code_scan`, repeat until clean (per global rule).
   - If a finding is a false positive, file an exception with justification — do not silently ignore.
4. **Trust prompt**: first scan in a new directory may require `snyk_trust path=...` consent. This is a one-time per-folder gate.

### Helper: `bin/snyk-scan.sh`

A thin wrapper that runs `snyk code test` from the CLI (not via MCP — useful for shell / pre-commit hooks / dispatched coder sessions that don't have an MCP-enabled host):

```bash
# Scan all changes in the current commit:
bin/snyk-scan.sh                 # last commit
bin/snyk-scan.sh HEAD~3..HEAD    # range
bin/snyk-scan.sh --all           # full repo
```

See `bin/snyk-scan.sh --help`. See also the CLI-only quickstart above.

## When Claude itself should call `snyk_code_scan`

| Scenario                                                            | Action                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Session just generated/modified first-party code in supported lang  | Call `snyk_code_scan` on the changed paths **before reporting DONE**.                   |
| Session only edited docs / markdown / config                        | Skip.                                                                                   |
| Session edited dependency manifests (`package.json`, `Cargo.toml`)  | Call `snyk_sca_scan` instead (or in addition).                                          |
| Session edited IaC (terraform, k8s, dockerfile)                     | Call `snyk_iac_scan`.                                                                   |
| MCP not available in session (no Snyk tools listed)                 | Fall back to `bin/snyk-scan.sh` via Bash. Document MCP unavailability in DONE report.   |

## Troubleshooting

- **`snyk: command not found`** — re-run `npm install -g snyk`; check `which snyk` and `$PATH`.
- **`claude mcp list` doesn't show snyk** — re-run `claude mcp add snyk -s user -- snyk mcp -t stdio` and restart the session.
- **`snyk_code_scan` returns "User not authenticated"** — first verify shell auth with `snyk whoami` (NOT `snyk config get api`, which returns blank under OAuth). If `snyk whoami` succeeds but MCP still says unauthenticated, the MCP server process was spawned **before** OAuth completed and cached the un-auth state — restart the Claude Code session (or kill the `snyk mcp` child process so Claude reconnects). New sessions inherit the post-OAuth state immediately.
- **`snyk code test` returns "Snyk Code is not enabled" (SNYK-CODE-0005, HTTP 403)** — account-level, not tooling. Snyk Code (SAST) must be enabled for your Snyk organization. Enable in the Snyk dashboard: <https://app.snyk.io/org/<your-org>/manage/settings> → Code → toggle on. Free tier supports Snyk Code for individuals; org/team accounts may require admin approval. The CLI / MCP setup is correct in this case — the gate is on Snyk's side.
- **`snyk config get api` is blank after OAuth completes** — **expected**, not a bug. Use `snyk whoami` instead. The OAuth flow (CLI ≥ 1.1293) stores credentials in its own keystore; `snyk config get api` reads the legacy token-mode location only.
- **OAuth browser opens but never returns / stuck on "Authenticating…"** — the local callback listener (default port 8080) is occupied or blocked. Diagnose:
  ```bash
  lsof -nP -iTCP:8080 -sTCP:LISTEN    # see who holds the port
  ```
  Workarounds, in order: (a) free port 8080 (kill the held process if safe), (b) use the **token fallback** (Step 2-alt) — no port needed, (c) if your corporate firewall blocks the OAuth redirect, the token fallback is the only reliable path.
- **`snyk auth` prints a URL but no browser opens** — common in headless / SSH sessions. Copy the URL into a browser on your local machine, complete login, then return — the CLI on the remote will detect the callback if the machine is reachable. If not reachable, use the token fallback.
- **Rate-limited (`429` / `quota exceeded`)** — free-tier limit reached (100 SAST tests/month); either wait for next billing cycle or upgrade plan.
- **`snyk mcp` MCP server exits immediately** — check `snyk --version` (need ≥ 1.1293 for MCP subcommand). Update with `npm install -g snyk@latest`.

## References

- Official manifest: <https://github.com/snyk/agentic-integration-wrappers/blob/main/server.json>
- Snyk MCP repo: <https://github.com/snyk/studio-mcp>
- MCP registry entry: `io.snyk/mcp` on <https://modelcontextprotocol.io>
- Snyk CLI docs: <https://docs.snyk.io/snyk-cli>
- Global rule: `~/.claude/CLAUDE.md` (Snyk Security At Inception)
- AGENTS.md delegation checklist row: "Snyk Security At Inception" — coder-dispatch-time inject requirement
- Propagation mechanism: `aigentry-devkit` scaffold (`lib/scaffold/project/generate.js`, task #130)
