#!/usr/bin/env bash
# spawn-telemetry-report.sh — Aggregate ADR-MF #9 spawn-validation telemetry.
# Reads ~/.aigentry/telemetry/spawn-events-YYYY-MM-DD.ndjson files and writes
# a markdown summary (orch dashboard surface, default state/telemetry/SUMMARY.md).
# OQ6 — parser is `node -e` (Article 17 무의존: no jq dep; Node ≥20 already required).
# Usage: spawn-telemetry-report.sh [--days N] [--root DIR] [--out PATH]
set -euo pipefail

days=7; root="${HOME}/.aigentry/telemetry"; out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --days) days="$2"; shift 2 ;;
    --root) root="$2"; shift 2 ;;
    --out)  out="$2";  shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 64 ;;
  esac
done
if [ -z "$out" ]; then mkdir -p state/telemetry; out="state/telemetry/SUMMARY.md"; fi

files=()
for ((i = days - 1; i >= 0; i--)); do
  d=$(date -u -v "-${i}d" +%Y-%m-%d 2>/dev/null || date -u -d "${i} days ago" +%Y-%m-%d)
  f="${root}/spawn-events-${d}.ndjson"
  [ -f "$f" ] && files+=("$f")
done

if [ "${#files[@]}" -eq 0 ]; then
  printf "# Spawn validation telemetry\n\n_No NDJSON files under \`%s\` in the last %s days._\n" \
    "$root" "$days" > "$out"
  echo "wrote $out (0 day(s))"; exit 0
fi

node -e '
const fs = require("node:fs");
const files = process.argv.slice(1);
const counts = { spawn_accepted: 0, spawn_rejected: 0, spawn_degraded: 0, mode_changed: 0 };
const reasons = new Map(); const transitions = [];
for (const f of files) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
  const s = line.trim(); if (!s) continue;
  const e = JSON.parse(s);
  counts[e.event] = (counts[e.event] ?? 0) + 1;
  if (e.event === "spawn_rejected") reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
  if (e.event === "mode_changed") transitions.push(e.ts + "  " + e.reason);
}
const top = [...reasons.entries()].sort((a,b) => b[1]-a[1]).slice(0, 5);
const L = ["# Spawn validation telemetry", "", `_Aggregated from ${files.length} daily NDJSON file(s)._`, ""];
L.push("## Counts by event", "");
for (const k of ["spawn_accepted","spawn_rejected","spawn_degraded","mode_changed"]) L.push(`- ${k}: ${counts[k]}`);
L.push("", "## Top rejection reasons", "");
if (top.length === 0) L.push("_None._"); else for (const [r,n] of top) L.push(`- ${r}: ${n}`);
L.push("", "## Mode transitions", "");
if (transitions.length === 0) L.push("_None._"); else for (const t of transitions) L.push(`- ${t}`);
L.push("");
process.stdout.write(L.join("\n"));
' "${files[@]}" > "$out"
echo "wrote $out (${#files[@]} day(s))"
