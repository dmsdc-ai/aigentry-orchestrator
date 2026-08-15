#!/usr/bin/env node
// spawn-telemetry-report.mjs — Aggregate ADR-MF #9 spawn-validation telemetry.
// Reads ~/.aigentry/telemetry/spawn-events-YYYY-MM-DD.ndjson files and writes
// a markdown summary (orch dashboard surface, default state/telemetry/SUMMARY.md).
// Usage: spawn-telemetry-report.mjs [--days N] [--root DIR] [--out PATH] [--asof YYYY-MM-DD]
// --asof anchors the freshness window to a fixed UTC date (default: today). Used to
// backfill/replay a specific date and to make date-sensitive tests deterministic.
//
// #900 (0.7) — a same-contract port of spawn-telemetry-report.sh, which was the last
// bash invoked from inside `npm test` and therefore the last thing standing between the
// regression suite and a Windows runner. Flags, output bytes, exit codes and the "wrote
// ..." line are unchanged; the shell only ever wrapped a `node -e` parser and a `date`
// call, and both moved inline. The `date -u -v -Nd` / `date -u -d` pair it used was also
// a portability bug in its own right: the BSD form is macOS-only, the GNU form is
// Linux-only, and the script depended on the first failing to reach the second.
//
// It stays under bin/ rather than moving to scripts/ because package.json files[] ships
// bin/ wholesale and does not ship scripts/: relocating it would quietly drop a shipped
// file from the tarball, which is an install-contract change, not a port. Keeping the
// directory also keeps tests/packaging/T96 assertion 4 (manifest bin/ count == git
// ls-files bin) a one-line rename instead of a three-list edit.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let days = 7;
let root = path.join(os.homedir(), ".aigentry", "telemetry");
let out = "";
let asof = "";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const v = argv[i + 1];
  switch (argv[i]) {
    case "--days": days = Number(v); i++; break;
    case "--root": root = v; i++; break;
    case "--out":  out = v;  i++; break;
    case "--asof": asof = v; i++; break;
    default:
      process.stderr.write(`unknown arg: ${argv[i]}\n`);
      process.exit(64);
  }
}
if (!out) {
  fs.mkdirSync("state/telemetry", { recursive: true });
  out = "state/telemetry/SUMMARY.md";
}

// Snyk Code flags the three fs calls below as CWE-23, because --root and --out reach them
// from argv. Reviewed and accepted, not silenced blind: argv here IS the operator, this is
// a maintainer-run report generator with no caller but a human or npm test, and "write the
// summary where I said" is its entire contract — a containment jail would have no base
// path to contain to and would break both consumer tests, which pass mktemp roots. The
// same dataflow existed verbatim in the spawn-telemetry-report.sh this replaces ($out into
// a redirect, $root into the embedded node -e); Snyk does not scan bash, so the port made
// an existing property visible rather than introducing a new one. path.resolve() was tried
// first and does not satisfy the rule, so it is not carried here for appearance's sake.

// The window walks oldest -> newest, matching the shell's descending loop, because the
// mode-transition list below is emitted in file order.
const anchor = asof ? Date.parse(`${asof}T00:00:00Z`) : Date.now();
const files = [];
for (let i = days - 1; i >= 0; i--) {
  const d = new Date(anchor - i * 86400000).toISOString().slice(0, 10);
  const f = path.join(root, `spawn-events-${d}.ndjson`);
  if (fs.existsSync(f)) files.push(f);
}

if (files.length === 0) {
  fs.writeFileSync(
    out,
    `# Spawn validation telemetry\n\n_No NDJSON files under \`${root}\` in the last ${days} days._\n`,
  );
  process.stdout.write(`wrote ${out} (0 day(s))\n`);
  process.exit(0);
}

const counts = { spawn_accepted: 0, spawn_rejected: 0, spawn_degraded: 0, mode_changed: 0 };
const reasons = new Map();
const transitions = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const e = JSON.parse(s);
    counts[e.event] = (counts[e.event] ?? 0) + 1;
    if (e.event === "spawn_rejected") reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
    if (e.event === "mode_changed") transitions.push(e.ts + "  " + e.reason);
  }
}
const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const L = ["# Spawn validation telemetry", "", `_Aggregated from ${files.length} daily NDJSON file(s)._`, ""];
L.push("## Counts by event", "");
for (const k of ["spawn_accepted", "spawn_rejected", "spawn_degraded", "mode_changed"]) L.push(`- ${k}: ${counts[k]}`);
L.push("", "## Top rejection reasons", "");
if (top.length === 0) L.push("_None._"); else for (const [r, n] of top) L.push(`- ${r}: ${n}`);
L.push("", "## Mode transitions", "");
if (transitions.length === 0) L.push("_None._"); else for (const t of transitions) L.push(`- ${t}`);
L.push("");
fs.writeFileSync(out, L.join("\n"));
process.stdout.write(`wrote ${out} (${files.length} day(s))\n`);
