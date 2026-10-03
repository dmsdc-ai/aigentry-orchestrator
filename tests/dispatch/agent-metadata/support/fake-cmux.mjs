#!/usr/bin/env node
// Fake cmux CLI recorder (#1162 tester fixture). NEVER contacts a host.
// Scenario: JSON file at $FAKE_CMUX_SCENARIO keyed by verb:
//   { "capabilities": {rc, stdout, stderr, sleepMs}, "rpc:<method>": {...}, "set-status": {...} }
// Every call is appended to $FAKE_CMUX_LOG as one JSON line {argv}. Any argv the
// scenario does not name is recorded as UNEXPECTED and exits 97 (fail closed).
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_CMUX_LOG;
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_CMUX_SCENARIO, "utf8"));
const key = argv[0] === "rpc" ? `rpc:${argv[1]}` : argv[0];
const s = scenario[key];
fs.appendFileSync(log, JSON.stringify({ argv, unexpected: s === undefined }) + "\n");
if (s === undefined) {
  process.stderr.write("fake-cmux: UNEXPECTED\n");
  process.exit(97);
}
if (s.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.sleepMs);
if (s.stdout) process.stdout.write(s.stdout);
if (s.stderr) process.stderr.write(s.stderr);
process.exit(s.rc ?? 0);
