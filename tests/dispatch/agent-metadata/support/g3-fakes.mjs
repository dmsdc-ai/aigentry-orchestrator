#!/usr/bin/env node
// Multi-call fake for the G3 reconciler fixture (#1162 tester). Role = basename:
//   wh-cli.sh | dispatch-registry.py | session-probe.py | policy.py | telepty
// Scenario: $G3_SCENARIO JSON. Every call is appended to $G3_LOG as
// {role, argv, stdin?}. Anything the scenario does not cover → UNEXPECTED, exit 97.
import * as fs from "node:fs";
import * as path from "node:path";

const role = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(process.env.G3_SCENARIO, "utf8"));
const rec = { role, argv };
let stdin = "";
if (role === "policy.py") {
  try { stdin = fs.readFileSync(0, "utf8"); } catch { /* none */ }
  rec.stdin = stdin;
}
const done = (code, out = "") => {
  fs.appendFileSync(process.env.G3_LOG, JSON.stringify(rec) + "\n");
  if (out) process.stdout.write(out);
  process.exit(code);
};
const unexpected = () => { rec.unexpected = true; done(97); };

switch (role) {
  case "wh-cli.sh": {
    const [verb, ...rest] = argv;
    if (verb === "agent-meta-caps") done(s.capsRc ?? 0);
    if (verb === "agent-meta-set") {
      const sid = rest[0];
      // r2 delta: an array value is a per-call sequence (duplicate-sid rows).
      const v = s.setRc?.[sid] ?? 0;
      if (!Array.isArray(v)) done(v);
      const ctr = `${process.env.G3_LOG}.seq.${sid}`;
      const n = fs.existsSync(ctr) ? Number(fs.readFileSync(ctr, "utf8")) : 0;
      fs.writeFileSync(ctr, String(n + 1));
      done(v[n] ?? 97);
    }
    if (verb === "set-status") done(0);
    if (verb === "prune-orphans") done(0, "0\n");
    if (verb === "lookup") done(0, "");
    if (verb === "alive") done(0);
    unexpected();
    break;
  }
  case "dispatch-registry.py": {
    const a = argv.join(" ");
    if (a === "list --live --fields assigned.sid,lifecycle.state,ref_path,re_dispatch_count") {
      done(0, s.live.map((r) => `${r.sid}\t${r.state}\tnull\t0\n`).join(""));
    }
    if (a === "list --not-retired --fields assigned.sid") done(0, s.live.map((r) => `${r.sid}\n`).join(""));
    if (a === "list --keep-alive --fields assigned.sid") done(0, "");
    unexpected();
    break;
  }
  case "session-probe.py": {
    if (argv[0] !== "--sid" || argv.length !== 2) unexpected();
    const p = s.probe?.[argv[1]];
    done(0, p === undefined ? "" : JSON.stringify(p) + "\n");
    break;
  }
  case "policy.py": {
    // inert verdict: NOOP with next_status == status (no lifecycle write)
    const status = argv[1];
    done(0, JSON.stringify({ action: "NOOP", reason: "fixture", status, next_status: status }) + "\n");
    break;
  }
  case "telepty": {
    if (argv.join(" ") === "list --json") done(0, JSON.stringify(s.sessions) + "\n");
    unexpected();
    break;
  }
  default:
    unexpected();
}
