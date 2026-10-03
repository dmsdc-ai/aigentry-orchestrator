#!/usr/bin/env node
// Fake cmux CLI recorder for g2c-pinned-clear (#1162 tester fixture). NEVER contacts a host.
// Scenario: JSON file at $PINNED_CLEAR_CMUX_SCENARIO keyed by verb
//   ("capabilities", "rpc:<method>", "close-workspace", ...):
//   { rc, stdout, stderr, sleepMs, copy: [[src, dst], ...] }
// `copy` rewrites dst in place (keeps its mode) before answering: it is how a case moves the
// sealed binding under the adapter at an exact point of the call sequence.
// A verb the scenario does not name answers rc 0 / empty and is recorded with known:false, so
// the legacy teardown verbs stay visible in the ordered call log the suite pins exactly.
// Every call appends {who:"cmux", argv, known} to $PINNED_CLEAR_SEQ_LOG (shared with
// support/pinned-clear-actuators.mjs, so one log orders every actuator).
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.PINNED_CLEAR_CMUX_SCENARIO, "utf8"));
const verb = argv[0] === "--json" ? argv[1] : argv[0];
const key = verb === "rpc" ? `rpc:${argv[1]}` : verb;
const s = scenario[key];
fs.appendFileSync(process.env.PINNED_CLEAR_SEQ_LOG, JSON.stringify({ who: "cmux", argv, known: s !== undefined }) + "\n");
if (s === undefined) process.exit(0);
for (const [src, dst] of s.copy ?? []) fs.writeFileSync(dst, fs.readFileSync(src));
if (s.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.sleepMs);
if (s.stdout) process.stdout.write(s.stdout);
if (s.stderr) process.stderr.write(s.stderr);
process.exit(s.rc ?? 0);
