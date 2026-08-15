# Public-Exposure Hygiene Inventory — `aigentry-orchestrator`

- **Date**: 2026-06-13
- **Author**: analyst session (`analyst-622`), tq#622
- **Mode**: READ-ONLY inventory + risk assessment. No scrubbing / edits / commits performed.
- **Trigger**: `dmsdc-ai/aigentry-orchestrator` flipped **PRIVATE → PUBLIC on 2026-06-13**.
- **Repo state at scan**: HEAD `38e72dd`, 128 commits, 421 tracked files.
- **Pre-flight (separate)**: claimed zero secrets in tracked files/history; monetization/business strategy docs untracked. **This inventory independently re-verified the secrets claim — it holds (see §0).**

> A public repo exposes the **full git HISTORY**, not just the working tree. Where it matters this report splits **current-file** vs **history-only**, because a file-scrub removes only the former.

---

## 0. Secret re-verification (gate check — PASSED)

Independent scan for real credential values across **task-queue / all tracked files / full git history** (`ghp_`, `sk-`, `npm_`, `AKIA…`, `tskey-`, `xoxb-`, JWT `eyJ…`):

- **One** match, both in current tree and history: `tskey-abcdef1432341818` at `docs/reports/2026-05-09-cross-machine-ssh-tools-survey.md:135`.
- **Verdict: NOT a secret.** It is a documentation placeholder inside an illustrative CLI line (`tailscale up --auth-key=tskey-abcdef1432341818`); the `abcdef1432341818` body is obvious dummy hex, not a real Tailscale key. Cosmetic only.

→ **No genuinely-sensitive secret leak found. Pre-flight claim confirmed. No HOLD raised.**

---

## Risk-ranked summary

| Rank | Concern | What's exposed | Removable by file-scrub? | Recommendation |
|------|---------|----------------|--------------------------|----------------|
| 🟠 **MEDIUM** | (a) commit-identity | Real personal Gmail in 1 commit + username/hostname in all 128 commits — **history-only** | ❌ No (history rewrite only) | Decide: accept vs `filter-repo` |
| 🟡 **LOW–MED** | (b) private-sibling refs | Names + internal API surface of 5–6 PRIVATE repos; install still works | ✅ Mostly (docs/current files) | Targeted file edits; low urgency |
| 🟢 **LOW** | (c) task-queue notes | 596 internal eng task notes + roadmap/strategy intent | ✅ Yes (current file) | Business judgment — user decides |
| ⚪ **COSMETIC** | (a) personal paths in docs | 98 `/Users/duckyoungkim/...` strings in docs/tests | ✅ Yes (current files) | Optional tidy |

---

## (a) Personal / machine identifiers

### a.1 — 🟠 Commit author/committer identity (HISTORY-ONLY, **not** in working tree)

This is the **most notable** item in (a). It lives in git metadata, so `git grep` on tracked files does **not** see it and a file-scrub cannot remove it.

| Identity (in commit metadata) | Where | Sensitivity |
|---|---|---|
| `duckyoungkim <duckyoungkim@duckyoungkimui-MacBookPro.local>` | **all 128 commits** (author + committer) | Username + local machine hostname. Low-moderate. |
| `E-coder-mf13-boot-adapter <banggayo3@gmail.com>` | **1 commit** `426f3a9` (`feat(session): per-CLI boot adapter…`) | **Real personal Gmail address.** Highest-sensitivity item in this inventory. |

- The Gmail leak (`banggayo3@gmail.com`) is **not** present in any tracked file (`git grep` = 0) — it is **history-only**, in one commit's author line. A single stray local git config produced it.
- Impact: real but bounded — a personal email becomes harvestable from the public commit log. No password/credential value; it's PII/contactability, not access.

### a.2 — ⚪ Personal absolute paths in tracked content (current-file, cosmetic)

- **98 occurrences** of `/Users/duckyoungkim/...` across **17 tracked files** (all docs/tests — zero in shipped `src/`).
- Heaviest: `docs/reports/2026-05-24-phase5-spec-codex-review.md` (21), `…herdr-vs-aterm-comparison.md` (20), `…phase5a-spec-codex-rereview.md` (9).
- These are example paths / pasted tool output inside design docs — they reveal the home-dir layout but leak no data. **Cosmetic.**
- Machine hostname `duckyoungkimui-MacBookPro.local` also appears **in 2 tracked docs** (telepty L2 ADR ×2) in addition to the commit metadata above.
- `username "duckyoungkim"` total: 142 occurrences (superset of the paths above).

### a.3 — Emails in tracked files (current-file)

15 distinct addresses; **all examples/fakes** (`claude-bot@example.com`, `user@host.example.com`, `remote-codex@bob.tailnet`, `duckyoungkim@*.ts.net` sanitized tailnet samples, etc.). No real inbox exposed in tracked files — the only **real** email is the history-only Gmail in a.1.

### (a) remediation options + tradeoff

| Option | Removes | Cost / blast radius |
|---|---|---|
| **A. Do nothing** | — | Personal Gmail + hostname remain forever in public history. Acceptable only if user is fine with the Gmail being public. |
| **B. File-scrub current files** (coder task) | a.2 + a.3 doc strings only | Cheap, low-risk. **Does NOT touch a.1** (the Gmail/hostname in commit metadata stay). |
| **C. History rewrite** (`git filter-repo --mailmap` to rewrite author identity; optionally redact paths) | a.1 (and a.2/a.3 in history) | **Heavy & disruptive**: rewrites all 128 SHAs → breaks every existing clone/fork, invalidates any commit links/PRs, force-push required. Justified only by a.1 (the real Gmail). |

**Recommendation:** The only thing warranting history rewrite is **a.1's personal Gmail**. Decision is the user's:
- If the Gmail being publicly visible is unacceptable → **C** (`git filter-repo` mailmap remap of `banggayo3@gmail.com` and the hostname identity to a neutral one like `duckyoungkim@users.noreply.github.com`), done early while forks are few.
- If acceptable → **B** for cosmetic tidiness of a.2/a.3, skip the rewrite.
- Repo is fresh-public (2026-06-13) with presumably ~no external forks yet → **if C is ever going to happen, now is the cheapest moment.** Flag this timing to the user.

---

## (b) Sibling-repo references + visibility

Visibility resolved live via `gh repo view dmsdc-ai/<name>`:

| Referenced repo | GitHub visibility | npm pkg (public?) | tracked refs | Risk |
|---|---|---|---|---|
| `aigentry` (constitution) | 🟢 PUBLIC | — | 1 | none |
| `aigentry-telepty` | 🟢 PUBLIC | published | 20 (dmsdc) / 190 (name) | none |
| `aigentry-devkit` | 🟢 PUBLIC | published | 7 | none |
| `aigentry-deliberation` | 🟢 PUBLIC | published | 7 | none |
| `aigentry-orchestrator` | 🟢 PUBLIC | published | self | none |
| `aigentry-ssot` | 🔴 **PRIVATE** | **public on npm (1.0.0)** | 10 | info leak |
| `aigentry-logger` | 🔴 **PRIVATE** | **public on npm (0.2.0)** | 10 | info leak |
| `aigentry-amplify` | 🔴 **PRIVATE** | **not on npm (E404)** | 7 | info leak |
| `aigentry-brain` | 🔴 **PRIVATE** | public on npm (0.2.7) | 3 | info leak |
| `aigentry-dustcraw` | 🔴 **PRIVATE** | — | 1 | info leak |
| `aigentry-platform` | ⚫ not-found/no-access | E404 | 1 | speculative ref only |
| `aigentry-aterm`, `aigentry-architect` | ⚫ not-found/no-access | — | 50 / 34 (name only) | name leak only |

### Key nuance — this is an INFORMATION leak, not a broken build

`package.json` declares **runtime deps** on two PRIVATE-repo packages:
```
"@dmsdc-ai/aigentry-logger": "^0.2.0"   (src/telemetry/logger-emit.ts imports it)
"@dmsdc-ai/aigentry-ssot":   "^1.0.0"
```
**Both are published *publicly on npm* even though their GitHub repos are PRIVATE** (`npm view` returns `0.2.0` / `1.0.0`). So **external `npm install` still succeeds** — there is **no broken-install** for these two. The GitHub *source* link is what's private/404 for outsiders.

Therefore the (b) risk is **information disclosure**, ranked 🟡 LOW–MEDIUM:
1. Confirms the *existence + names* of private repos (`ssot`, `logger`, `amplify`, `brain`, `dustcraw`).
2. **Most notable:** `docs/reports/2026-06-10-structure-audit.md:27,34,67` leaks **internal API surface** of private `aigentry-ssot` — exported symbol names (`Capability, CAPABILITIES, Role, ROLES, ROLE_CAPABILITY_SUBSET`), the `dist/index.d.ts` path, and the orchestrator↔ssot "mirror" relationship. That's design-internal detail about a repo the user chose to keep private.
3. `.claude/commands/ship.md:14,17,18` lists `amplify`/`brain`/`dustcraw` as publishable packages — reveals the private product roadmap/lineup.
4. `docs/superpowers/specs|plans/2026-03-15-aigentry-amplify-*.md` contains a full design spec for private, unpublished `aigentry-amplify`.

Representative `file:line` (not exhaustive):
- `package.json:17` · `package-lock.json:12,24,61-63` — logger dep (private repo, public npm)
- `package-lock.json:13,45,77-79` — ssot dep (private repo, public npm)
- `src/telemetry/logger-emit.ts:1,18` — code import of private-repo pkg
- `docs/reports/2026-06-10-structure-audit.md:27,34,67` — **ssot internal API surface** ⬅ highest-value leak in (b)
- `.claude/commands/ship.md:14,17,18` — amplify/brain/dustcraw lineup
- `docs/adr/2026-05-05-telepty-devkit-boundary.md:682` — speculative `aigentry-platform`

### (b) remediation options

| Option | Action | Note |
|---|---|---|
| **A. Make the private siblings public** | flip `ssot`/`logger` (already public-on-npm anyway) to public GitHub | Resolves the leak by removing the asymmetry. Cheapest if there's no reason to keep them private; **the user owns this call.** |
| **B. File-scrub the doc references** (coder task) | redact private-repo names/API surface in `docs/reports/2026-06-10-structure-audit.md`, `ship.md`, amplify specs | Current-file edits, low risk. **Cannot remove `package.json`/code deps** without breaking the build — those legitimately need the (public-on-npm) packages. |
| **C. Do nothing** | — | Acceptable: install works; the leak is names + some API surface, not credentials. |

**Recommendation:** Low urgency. The single edit with real value is **redacting the ssot internal-API paragraph in `2026-06-10-structure-audit.md`** (option B, scoped). The `package.json`/`logger-emit.ts` deps are fine to keep (packages are public on npm) — do **not** rip them out. Bigger-picture, if `ssot`/`logger` have no reason to stay private, **A** removes the whole concern; flag to user as the cleaner fix. History rewrite is **not** warranted here.

---

## (c) `state/task-queue.json` internal notes

- Tracked → public. **534 KB, 596 tasks**, each `{id, desc, priority, status, session, note}`. `desc`+`note` are free-text internal narratives.
- **No secret values** found in the queue (§0 scan clean).

Category scan over `desc`+`note` (a task can match multiple):

| Category | Tasks | Real sensitivity | Examples |
|---|---|---|---|
| "security"-keyword | 57 | **Low** — overwhelmingly benign: bugfix narratives, "snyk scan" setup, sanitization tasks. No live-vuln disclosure. | #544 (cmux socket bugfix writeup), #130 (Snyk OAuth setup steps) |
| third-party/vendor names | 147 | **Low** — expected: `claude`/`codex`/`gemini`/`openai`/`npm`/`github` as tooling context, not credentials. | #115, #28, #40 |
| infra / internal paths | 28 | **Low–cosmetic** — `tailscale`/`.ts.net`/`/Users/…` in eng context. | #24, #26, #54 (aterm tailscale tasks) |
| **business/strategy/roadmap** | **11** | **Low–MEDIUM** — reveals *strategic intent*, the one category worth a business eye. | #350 "비즈니스 viability — 시장 segmentation, 경쟁분석 (Cursor/Claude Code/Continue/Aider), 비즈니스 모델 옵션"; #282 over-engineering audit; #269 3-tier sync model |
| session ids | 2 | Cosmetic — internal session labels. | #522, #606 |

### Assessment
- The queue is a **public window into the internal dev backlog**: bug root-causes, design churn, unbuilt features (e.g. private `amplify`), and — most notably — **roadmap/strategy intent** (#350 market-segmentation & competitor analysis, monetization-adjacent thinking). The dispatch confirmed the *monetization strategy docs* are untracked, but **strategy *intent* still bleeds through these task lines.**
- Nothing here is a hard secret or customer/PII leak. It's a **business-judgment** exposure: are you comfortable competitors/users reading your backlog and strategic framing?

### (c) remediation options

| Option | Action | Tradeoff |
|---|---|---|
| **A. Accept (transparency)** | leave as-is | "Build in public" posture; zero effort. Backlog + strategy intent stay visible. |
| **B. Untrack the file** | `git rm --cached state/task-queue.json` + `.gitignore`, keep local | Removes future exposure from working tree. **History copies remain public** unless combined with history rewrite. Also: confirm nothing in the public toolchain *reads the tracked copy* before untracking. |
| **C. Targeted redaction** | strip/relocate the ~11 strategy-intent notes (e.g. #350), keep eng tasks public | Middle path; current-file edit. Preserves transparency for eng items. |

**Recommendation:** This is **the user's business call**, not the analyst's — surfaced here, not decided. If any discomfort with public strategy: **C** (cheap, scoped to ~11 tasks) is the proportionate move; **B** if the whole backlog should go private (pair with history rewrite only if past snapshots also matter). Engineering task notes alone don't warrant action.

---

## Cross-cutting note on history rewrite

A `git filter-repo` pass would be **the same operation** for (a.1 identity), (b history copies), and (c history copies) — so if the user decides the personal Gmail (a.1) justifies a rewrite, fold (b)/(c) history cleanup into that single pass rather than running it twice. Cost is paid once: all 128 SHAs change, clones/forks break, force-push. **Best done now** while the repo is hours-old-public with minimal external forks.

---

## Bottom line for the user (decisions owed)

1. **(a.1) personal Gmail `banggayo3@gmail.com` in commit `426f3a9`** — the one item with real PII weight, history-only. **Accept publicly, or `git filter-repo` now?** ← primary decision.
2. **(b)** private-sibling info leak is low-urgency; one worthwhile scoped edit (ssot API surface in `2026-06-10-structure-audit.md`); or make `ssot`/`logger` public to dissolve it. Keep the `package.json` deps (public on npm).
3. **(c)** task-queue backlog is public — a **business transparency** choice; ~11 strategy-intent tasks are the only notable lines. Accept / redact-11 / untrack.

Remediation itself is a **separate coder task after the user decides** — this report performed **no** changes.
