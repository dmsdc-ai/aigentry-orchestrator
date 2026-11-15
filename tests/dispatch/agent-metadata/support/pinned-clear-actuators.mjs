#!/usr/bin/env node
// Generic actuator recorder for g2c-pinned-clear (#1162 tester fixture): telepty, ps, curl,
// kill, the dispatch registry and the wh-cli clear door. argv[2] = who. It never signals,
// connects to or executes anything; the suite installs it behind per-run wrappers and the
// harness tripwire shadows every real actuator name behind it.
// Behaviour from $PINNED_CLEAR_FAKE_SCENARIO[who]:
//   { stdout, stdoutFile, stderr, rc, sleepMs,
//     copyOnce: [[src, dst], ...]   first call only (marker file), rewrites dst in place,
//     copyOnceAt: n   (task 1270) OPTIONAL explicit positive-integer invocation ordinal of THIS who (1-based,
//                     counted from $PINNED_CLEAR_SEQ_LOG, this call included) at which copyOnce fires instead;
//                     absent → the original first-call behaviour, unchanged,
//     match: [{ argv0, ...same fields }]   the first entry whose argv0 equals argv[0] overrides }
// Every call appends {who, argv} to $PINNED_CLEAR_SEQ_LOG.
import * as fs from "node:fs";

const [who, ...argv] = process.argv.slice(2);
fs.appendFileSync(process.env.PINNED_CLEAR_SEQ_LOG, JSON.stringify({ who, argv }) + "\n");
const all = JSON.parse(fs.readFileSync(process.env.PINNED_CLEAR_FAKE_SCENARIO, "utf8"));
let s = all[who] ?? {};
const m = (s.match ?? []).find((x) => x.argv0 === argv[0]);
if (m) s = { ...s, ...m };
if (s.copyOnce && s.copyOnceAt !== undefined) {
  if (!Number.isSafeInteger(s.copyOnceAt) || s.copyOnceAt < 1) {
    process.stderr.write(`pinned-clear-actuators: copyOnceAt must be a positive integer, got ${JSON.stringify(s.copyOnceAt)}\n`);
    process.exit(98);
  }
  const nth = fs.readFileSync(process.env.PINNED_CLEAR_SEQ_LOG, "utf8").split("\n").filter(Boolean)
    .filter((l) => JSON.parse(l).who === who).length;
  const marker = `${process.env.PINNED_CLEAR_SEQ_LOG}.${who}.copied`;
  if (nth === s.copyOnceAt && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, "");
    for (const [src, dst] of s.copyOnce) fs.writeFileSync(dst, fs.readFileSync(src));
  }
} else if (s.copyOnce) {
  const marker = `${process.env.PINNED_CLEAR_SEQ_LOG}.${who}.copied`;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "");
    for (const [src, dst] of s.copyOnce) fs.writeFileSync(dst, fs.readFileSync(src));
  }
}
if (s.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.sleepMs);
if (s.stdoutFile) process.stdout.write(fs.readFileSync(s.stdoutFile));
if (s.stdout) process.stdout.write(s.stdout);
if (s.stderr) process.stderr.write(s.stderr);
process.exit(s.rc ?? 0);
