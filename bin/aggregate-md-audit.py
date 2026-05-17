#!/usr/bin/env python3
"""Aggregate sibling MD audit reports into one orchestrator summary.

Per-repo report format varies (LOC column placement, score column wrapping,
markdown bold, etc.). Parser uses proximity scan rather than fixed columns:

For each line that mentions `AGENTS.md` or `CLAUDE.md`, look for the *first*
`NN/100` token on the same line. Capture a grade letter (A-F with optional
+/-) appearing within ~30 chars after the score. The first matching row per
file wins (later rows are usually issue/criterion tables that re-cite scores).
"""

from __future__ import annotations

import re
from pathlib import Path

PROJECTS = Path("/Users/duckyoungkim/projects")
REPOS = [
    "aigentry-amplify", "aigentry-analyst", "aigentry-architect", "aigentry-aterm",
    "aigentry-brain", "aigentry-bridge", "aigentry-builder", "aigentry-context",
    "aigentry-deliberation", "aigentry-design", "aigentry-devkit", "aigentry-dustcraw",
    "aigentry-hooks", "aigentry-logger", "aigentry-registry", "aigentry-ssot",
    "aigentry-starter", "aigentry-telepty", "aigentry-tester",
]

FILE_RE = re.compile(r"(AGENTS\.md|CLAUDE\.md)", re.IGNORECASE)
SCORE_RE = re.compile(r"(\d{1,3})\s*/\s*100")
GRADE_RE = re.compile(r"\b([A-F][+-]?)\b")
LOC_RE = re.compile(r"(\d+)\s*(?:lines|LOC|loc|줄)\b|\((\d+)\s*lines?\)|\|\s*(\d{2,4})\s*\|")

ISSUES_RE = re.compile(r"(?:total[- ]issues?|Total issues?|\*\*Total issues?)\D*?(\d+)", re.IGNORECASE)
HIGHPRI_RE = re.compile(r"high[- ]priority(?:\s+recommendations?)?\D*?(\d+)", re.IGNORECASE)
STALE_RE = re.compile(r"stale(?:\s+(?:cross[- ]repo)?\s*(?:refs?|references|cross[- ]refs))?\D*?(\d+)", re.IGNORECASE)

HEADLINE_PATTERNS = [
    re.compile(r"Headline finding[^\n]*?:\s*\*?\*?\s*(.+?)(?=\n\n|\n---|\n##)", re.DOTALL | re.IGNORECASE),
    re.compile(r"## (?:Headline|TL;DR|Summary verdict)[^\n]*\n+(.+?)(?=\n\n|\n##)", re.DOTALL | re.IGNORECASE),
]


def grade_for(score: int | None) -> str:
    if score is None:
        return "?"
    if score >= 90:
        return "A"
    if score >= 70:
        return "B"
    if score >= 50:
        return "C"
    if score >= 30:
        return "D"
    return "F"


def parse_report(path: Path) -> dict:
    repo = path.parents[2].name
    text = path.read_text(encoding="utf-8", errors="replace")
    out: dict = {"repo": repo, "agents": None, "claude": None,
                 "issues": None, "highpri": None, "stale": None, "headline": None}

    # Score may appear on same line or in next ~5 lines (some reports put
    # the score under a section header "### 1. ./AGENTS.md — 48 LOC\n**Score: 58 / 100 (Grade C)**").
    lines = text.splitlines()
    seen = set()
    for i, line in enumerate(lines):
        for fm in FILE_RE.finditer(line):
            fname = fm.group(1).upper()
            key = "agents" if fname == "AGENTS.MD" else "claude"
            if key in seen:
                continue
            # Try same line first
            tail = line[fm.end():fm.end() + 200]
            sm = SCORE_RE.search(tail) or SCORE_RE.search(line[:fm.start()][-80:])
            grade_window = None
            if sm:
                grade_window = tail[sm.end(): sm.end() + 60]
            else:
                # Look at next ~5 lines for "Score: NN / 100" pattern
                for j in range(i + 1, min(i + 6, len(lines))):
                    nxt = lines[j]
                    if FILE_RE.search(nxt):
                        # Hit next file marker — stop searching
                        break
                    sm2 = SCORE_RE.search(nxt)
                    if sm2:
                        sm = sm2
                        grade_window = nxt[sm2.end(): sm2.end() + 60]
                        break
            if not sm:
                continue
            score = int(sm.group(1))
            if not (0 <= score <= 100):
                continue
            gm = GRADE_RE.search(grade_window or "")
            grade = gm.group(1) if gm else grade_for(score)
            out[key] = {"score": score, "grade": grade}
            seen.add(key)

    if m := ISSUES_RE.search(text):
        out["issues"] = int(m.group(1))
    if m := HIGHPRI_RE.search(text):
        out["highpri"] = int(m.group(1))
    if m := STALE_RE.search(text):
        out["stale"] = int(m.group(1))

    for pat in HEADLINE_PATTERNS:
        if m := pat.search(text):
            h = m.group(1).strip().replace("\n", " ")
            h = re.sub(r"\s+", " ", h)
            h = h.strip("* ")
            if len(h) > 240:
                h = h[:237] + "..."
            out["headline"] = h
            break

    return out


def main() -> None:
    rows = []
    for repo in REPOS:
        path = PROJECTS / repo / "docs" / "reports" / "2026-05-14-md-audit.md"
        if not path.exists():
            rows.append({"repo": repo, "missing": True})
            continue
        rows.append(parse_report(path))

    agents_scores = [r["agents"]["score"] for r in rows if r.get("agents")]
    claude_scores = [r["claude"]["score"] for r in rows if r.get("claude")]
    total_issues = sum((r.get("issues") or 0) for r in rows)
    total_highpri = sum((r.get("highpri") or 0) for r in rows)
    total_stale = sum((r.get("stale") or 0) for r in rows)

    avg_a = sum(agents_scores) / len(agents_scores) if agents_scores else 0
    avg_c = sum(claude_scores) / len(claude_scores) if claude_scores else 0

    print("# MD Audit Aggregation — aigentry ecosystem (19 sibling repos)\n")
    received = sum(1 for r in rows if not r.get("missing"))
    print(f"Date: 2026-05-14 · Reports on disk: {received}/{len(REPOS)} · Generated by `bin/aggregate-md-audit.py`\n")
    print("## Ecosystem-wide stats\n")
    print(f"- **AGENTS.md** mean: {avg_a:.1f}/100 ({grade_for(int(avg_a))}) · n={len(agents_scores)}")
    print(f"- **CLAUDE.md** mean: {avg_c:.1f}/100 ({grade_for(int(avg_c))}) · n={len(claude_scores)}")
    print(f"- Total issues (all repos): **{total_issues}**")
    print(f"- Total high-priority recommendations: **{total_highpri}**")
    print(f"- Total stale cross-repo refs: **{total_stale}**\n")

    print("## Per-repo table (sorted by AGENTS.md score, descending)\n")
    print("| Repo | AGENTS.md | CLAUDE.md | Issues | High-pri | Stale-refs |")
    print("|------|----------:|----------:|------:|--------:|----------:|")
    def sort_key(r):
        return -(r.get("agents", {}) or {}).get("score", -1), r.get("repo") or ""
    for r in sorted(rows, key=sort_key):
        if r.get("missing"):
            print(f"| {r['repo']} | (missing) | — | — | — | — |")
            continue
        a = f"{r['agents']['score']}/{r['agents']['grade']}" if r.get("agents") else "—"
        c = f"{r['claude']['score']}/{r['claude']['grade']}" if r.get("claude") else "—"
        print(f"| {r['repo']} | {a} | {c} | {r.get('issues') or '—'} | {r.get('highpri') or '—'} | {r.get('stale') or 0} |")

    print("\n## Lowest-scoring files (priority for remediation)\n")
    by_min = []
    for r in rows:
        if r.get("missing"):
            continue
        for label, key in [("AGENTS.md", "agents"), ("CLAUDE.md", "claude")]:
            d = r.get(key)
            if d:
                by_min.append((d["score"], r["repo"], label, d["grade"]))
    by_min.sort()
    for score, repo, label, grade in by_min[:12]:
        print(f"- **{score}/100 ({grade})** — `{repo}/{label}`")

    print("\n## Highest-scoring files (template candidates)\n")
    for score, repo, label, grade in sorted(by_min, reverse=True)[:6]:
        print(f"- **{score}/100 ({grade})** — `{repo}/{label}`")

    print("\n## Headline findings (per-repo)\n")
    for r in sorted(rows, key=lambda x: x.get("repo") or ""):
        if r.get("missing"):
            continue
        if r.get("headline"):
            print(f"- **{r['repo']}** — {r['headline']}")
        else:
            print(f"- **{r['repo']}** — _(no headline extracted; see `{r['repo']}/docs/reports/2026-05-14-md-audit.md`)_")


if __name__ == "__main__":
    main()
