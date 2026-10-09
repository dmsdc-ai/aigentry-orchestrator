// #1206 S1-A — the router's per-purpose policy: role × task class (`--class`) → cli / model / effort, and the
// cap fallback order from `role_fallback`. Stage 1 routes claude + codex only. Effort is a CLI-native token
// from `role_effort`, emitted on the decision and on each candidate of the row's own list (primary, then
// role_fallback), and absent wherever no row names it. Router-only: no dispatch, no classifier call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, fixture } from "./model-router-fixtures.js";

const REAL = join(REPO, "docs/model-profiles/model-routing-profile.md");
const CONFINABLE = ["claude", "codex"];
// PLAN §2.3, Stage 1 primary column: [role, class or "", cli, model, effort].
const OPUS = "claude-opus-5-5", ASTRA = "gpt-6-astra";
const STAGE1 = [
  ["architect", "", "claude", OPUS, "high"],
  ["analyst", "", "claude", OPUS, "high"],
  ["reviewer", "", "codex", ASTRA, "high"],
  ["coder", "", "codex", ASTRA, "medium"],
  ["coder", "integration", "claude", OPUS, "high"],
  ["tester", "", "codex", ASTRA, "low"],
  ["tester", "authoring", "codex", ASTRA, "low"], // stage 3 gives it gemini; until then the tester row
  ["builder", "", "codex", ASTRA, "low"],
  ["researcher", "", "codex", ASTRA, "medium"],
  ["researcher", "docs", "codex", ASTRA, "low"],
  ["logger", "", "codex", ASTRA, "low"],
] as const;
type Route = { cli: string; model: string; label: string; decided_by: string; effort?: string;
  candidates?: { cli: string; model: string; label: string; effort?: string }[] };
const parse = (r: { status: number | null; stdout: string; stderr: string }): Route => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", "the profile parses without a warning");
  return JSON.parse(r.stdout) as Route;
};

test("1206: the REAL profile gives every role × class its Stage-1 tuple, with or without --confined/--candidates", () => {
  const f = fixture();
  try {
    for (const [role, cls, cli, model, effort] of STAGE1) for (const extra of [[], ["--candidates", "1", "--confined", "1"]]) {
      const route = parse(f.router(["--role", role, "--profile", REAL, ...(cls ? ["--class", cls] : []), ...extra]));
      const at = `${role}${cls ? "." + cls : ""} ${extra.join(" ")}`;
      assert.deepEqual([route.cli, route.model, route.effort, route.decided_by], [cli, model, effort, "table"], at);
      if (!extra.length) assert.equal("candidates" in route, false, `${at}: plain shape`);
      else {
        // Stage 1 has two confinable models: the primary, then the other one, both at the row's effort.
        assert.deepEqual(route.candidates!.map((c) => [c.cli, c.effort]), [[cli, effort], [cli === "claude" ? "codex" : "claude", effort]], at);
        assert.deepEqual(route.candidates![0], { cli, model, label: route.label, effort }, at);
      }
    }
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("1206: an unknown class falls to the role row in every section", () => {
  const f = fixture();
  try {
    for (const [role, cls] of [["coder", "nope"], ["researcher", "web"], ["architect", "integration"], ["logger", "docs"]]) {
      const plain = parse(f.router(["--role", role!, "--profile", REAL, "--candidates", "1"]));
      const classed = parse(f.router(["--role", role!, "--profile", REAL, "--candidates", "1", "--class", cls!]));
      assert.deepEqual(classed, plain, `${role}.${cls}`);
    }
  } finally { f.cleanup(); }
});

test("1206: effort is absent when no row names it (unknown role, profile without role_effort, emergency)", () => {
  const f = fixture();
  try {
    for (const role of ["orchestrator", "unknown"]) {
      const route = parse(f.router(["--role", role, "--profile", REAL, "--candidates", "1", "--confined", "1"]));
      assert.deepEqual([route.label, route.cli, route.model], ["opus-5", "claude", OPUS], role);
      assert.equal("effort" in route, false, role);
      for (const c of route.candidates!) assert.equal("effort" in c, false, `${role}: ${c.label}`);
    }
    // The fixture profile has no role_effort: the decision keeps its exact pre-1206 shape.
    const r = f.router(["--class", "integration"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { cli: "codex", model: "gpt-6-astra", label: "gpt-6-astra", decided_by: "table",
      reason: "no task ref; role default", confidence: 0 });
    const missing = f.router(["--profile", join(f.root, "missing.md"), "--candidates", "1"]);
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal("effort" in JSON.parse(missing.stdout), false, "emergency route");
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("1206: candidates follow role_fallback, then profile order; effort only on the row's own list; class keys use '.'", () => {
  const f = fixture();
  try {
    const profile = join(f.root, "policy.md");
    writeFileSync(profile, [
      "---",
      "models:",
      '  - {label: opus-5, cli: claude, model: "claude-opus-5-5"}',
      '  - {label: gpt-6-astra, cli: codex, model: "gpt-6-astra"}',
      '  - {label: grok-4.6, cli: grok, model: "grok-4.6"}',
      '  - {label: gemini, cli: gemini, model: "gemini-3.8-flash-high"}',
      "default_table:",
      "  coder: gpt-6-astra",
      "  coder.integration: opus-5",
      "role_effort:   # role or role.class -> CLI-native token",
      "  coder: medium",
      "  coder.integration: xhigh",
      "role_fallback:",
      "  coder: gemini   invented   opus-5 gpt-6-astra",
      "  coder.integration: grok-4.6",
      "---",
      "body",
    ].join("\n"));
    const labels = (route: Route) => route.candidates!.map((c) => [c.label, c.effort ?? null]);
    const coder = parse(f.router(["--profile", profile, "--candidates", "1"]));
    assert.equal(coder.effort, "medium");
    assert.deepEqual(labels(coder), [["gpt-6-astra", "medium"], ["gemini", "medium"], ["opus-5", "medium"], ["grok-4.6", null]]);
    const integration = parse(f.router(["--profile", profile, "--candidates", "1", "--class", "integration"]));
    assert.deepEqual([integration.label, integration.effort], ["opus-5", "xhigh"]);
    assert.deepEqual(labels(integration), [["opus-5", "xhigh"], ["grok-4.6", "xhigh"], ["gpt-6-astra", null], ["gemini", null]]);
    const confined = parse(f.router(["--profile", profile, "--candidates", "1", "--confined", "1"]));
    assert.deepEqual(labels(confined), [["gpt-6-astra", "medium"], ["opus-5", "medium"]]);
    // A classifier pick inside the row's list carries the row effort; one outside it carries none.
    for (const [label, effort] of [["opus-5", "medium"], ["grok-4.6", undefined]] as const) {
      const r = f.router(["--profile", profile, "--ref", f.ref], { CLASSIFIER_REPLY: JSON.stringify({ label, reason: "fixture", confidence: 0.5 }) });
      const route = parse(r);
      assert.deepEqual([route.label, route.decided_by, route.effort], [label, "llm", effort]);
    }
  } finally { f.cleanup(); }
});

test("1206: --class is validated ^[a-z][a-z0-9-]{0,31}$ before any profile read; a refusal emits no route", () => {
  const f = fixture();
  try {
    for (const ok of ["a", "integration", "docs-2", "a" + "b".repeat(31)]) {
      const r = f.router(["--class", ok]);
      assert.equal(r.status, 0, `${ok}: ${r.stderr}`);
    }
    for (const bad of ["", "Integration", "2docs", "-x", "coder.integration", "a b", "a_b", "a" + "b".repeat(32), "é", "x\n"]) {
      const r = f.router(["--class", bad, "--ref", f.ref]);
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.equal(r.stdout, "", JSON.stringify(bad));
      assert.equal(r.stderr, "model-router: invalid --class (want ^[a-z][a-z0-9-]{0,31}$)\n", JSON.stringify(bad));
    }
    const dangling = f.router(["--class"]);
    assert.equal(dangling.status, 2, dangling.stderr);
    assert.equal(dangling.stdout, "");
    assert.equal(f.calls(), 0, "a refused --class never reaches the classifier");
  } finally { f.cleanup(); }
});

test("1206: a malformed role_effort token or an unknown section invalidates the profile (emergency route)", () => {
  const f = fixture();
  try {
    const base = ["---", "models:", '  - {label: gpt-6-astra, cli: codex, model: "gpt-6-astra"}', "default_table:", "  coder: gpt-6-astra"];
    for (const tail of [["role_effort:", "  coder: High"], ["role_effort:", "  coder: $(id)"], ["role_effort:", "  coder: medium high"],
      ["role_extra:", "  coder: x"]]) {
      const profile = join(f.root, "bad.md");
      writeFileSync(profile, [...base, ...tail, "---", ""].join("\n"));
      const r = f.router(["--profile", profile]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual([JSON.parse(r.stdout).label, JSON.parse(r.stdout).model, "effort" in JSON.parse(r.stdout)], ["opus-5", "claude-opus-5[1m]", false], tail.join(" "));
      assert.match(r.stderr, /^model-router: profile missing or invalid; using table\n$/);
    }
  } finally { f.cleanup(); }
});

test("1206: --confined never offers a non-confinable candidate for any role × class of the REAL profile", () => {
  const f = fixture();
  try {
    for (const role of ["architect", "analyst", "reviewer", "researcher", "coder", "tester", "builder", "logger", "orchestrator", "unknown"]) {
      for (const cls of [[], ["--class", "integration"], ["--class", "docs"], ["--class", "authoring"], ["--class", "zzz"]]) {
        const route = parse(f.router(["--role", role, "--profile", REAL, "--candidates", "1", "--confined", "1", ...cls]));
        assert.ok(CONFINABLE.includes(route.cli), `${role} ${cls.join(" ")}`);
        assert.deepEqual(route.candidates!.map((c) => c.cli).sort(), [...CONFINABLE], `${role} ${cls.join(" ")}`);
      }
    }
  } finally { f.cleanup(); }
});
