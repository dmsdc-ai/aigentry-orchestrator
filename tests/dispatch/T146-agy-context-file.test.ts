// T146 (#1093) — an agy worker's role contract is INSTRUCTION, not its first task.
// #1083 delivered the staged role+session contract as agy's initial interactive
// prompt (`--prompt-interactive <contract>`); the #1090 agy probe then acted on
// it with no task ref delivered (ran ps/read-screen/cat, then idled). agy 1.1.27
// has no --rules or system-prompt flag, but it auto-discovers a cwd GEMINI.md as
// an always-on rule (measured interactively — see the ADR), so the contract now
// rides #532's additive contextFile path, exactly like Gemini CLI.
//   (a) the agy role launcher carries NO prompt flag and NO contract text — the
//       contract reaches the worker only as the staged cwd GEMINI.md.
//   (b) that staged file is byte-identical to the composed effective_prompt.md
//       (role layer + session boot contract).
//   (c) agy gets no shadow home (it honors only $HOME, #1090) while the Gemini
//       CLI fallback keeps GEMINI.md + GEMINI_CLI_HOME.
//   (d) grok is untouched: its contract still rides --rules (no context file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./model-router-fixtures.js";

const SANDBOX = "role-sandbox/coder-router-fixture";
const staged = (f: ReturnType<typeof fixture>, name = "GEMINI.md") => join(f.aig, SANDBOX, name);

test("T146(a): the agy role launcher passes no prompt flag and no contract text", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "gemini", "--role", "coder"]);
    assert.equal(r.status, 0, r.stderr);
    const launcher = readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8");
    assert.match(launcher, /exec -a gemini agy --model gemini-3.8-flash-high --dangerously-skip-permissions/);
    assert.doesNotMatch(launcher, /--prompt-interactive|--rules/);
    assert.doesNotMatch(launcher, /FIXTURE-ROLE|FIXTURE-COMMON|Session boot contract/);
  } finally { f.cleanup(); }
});

test("T146(b): the contract reaches agy as the staged cwd GEMINI.md, byte-identical to effective_prompt.md", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "gemini", "--role", "coder"]);
    assert.equal(r.status, 0, r.stderr);
    const contract = readFileSync(staged(f), "utf8");
    assert.match(contract, /FIXTURE-ROLE/);
    assert.match(contract, /## Session boot contract/);
    assert.match(contract, /\*\*Role\*\*: `coder`/);
    // The memory noun is GEMINI.md — the file the worker is actually reading.
    assert.match(contract, /no project GEMINI\.md auto-loaded/);
    assert.equal(contract, readFileSync(join(f.aig, "sessions/router-fixture/boot/effective_prompt.md"), "utf8"));
  } finally { f.cleanup(); }
});

test("T146(c): agy gets no shadow home; the Gemini CLI fallback still gets GEMINI.md + GEMINI_CLI_HOME", () => {
  const f = fixture();
  try {
    assert.equal(f.dispatch([...f.spawnArgs, "--cli", "gemini", "--role", "coder"]).status, 0);
    assert.equal(existsSync(join(f.aig, SANDBOX, ".geminihome")), false);
    assert.doesNotMatch(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /GEMINI_CLI_HOME/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    assert.equal(g.dispatch([...g.spawnArgs, "--cli", "gemini", "--role", "coder"], { AIGENTRY_GEMINI_BINARY: "gemini" }).status, 0);
    assert.match(readFileSync(staged(g), "utf8"), /FIXTURE-ROLE/);
    assert.match(readFileSync(join(g.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"), /export GEMINI_CLI_HOME=/);
  } finally { g.cleanup(); }
});

test("T146(d): grok keeps the --rules flag delivery and stages no context file", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "grok", "--role", "coder"]);
    assert.equal(r.status, 0, r.stderr);
    const launcher = readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8");
    assert.match(launcher, /--rules /);
    assert.match(launcher, /FIXTURE-ROLE/);
    for (const name of ["GEMINI.md", "AGENTS.md"]) assert.equal(existsSync(staged(f, name)), false);
  } finally { f.cleanup(); }
});
