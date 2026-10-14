import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Rec = Record<string, any>;
const REPO = resolve(import.meta.dirname, "../../..");
const resolver = () => import(pathToFileURL(join(REPO, "bin/model-resolve.mjs")).href) as Promise<Rec>;
const evidence = () => import(pathToFileURL(join(REPO, "bin/model-evidence.mjs")).href) as Promise<Rec>;
const catalog = (): Rec => JSON.parse(readFileSync(join(REPO, "docs/model-profiles/model-catalog.json"), "utf8")) as Rec;
const mapping = (prefix: string, tier = "opus") => ({ prefix, tier });
const exe = { path: "/fixture/claude", realpath: "/fixture/claude", dev: 1, ino: 2, size: 3,
  mtimeMs: 4, version: "9.9.9", versionSource: "fixture" };
const row = (model: string, tier: string, lifecycle = "current") =>
  ({ model, tier, lifecycle, default_effort: "medium", retire_on: null, labels: [] });
const input = (c: Rec, routeModel: string, rows: Rec[] | null): Rec => ({
  cli: "claude", sid: "fixture-sid", task: "1223", today: "2026-10-13",
  route: { model: routeModel, decided_by: "table" }, catalog: c,
  surface: rows === null ? { id: "anthropic-models", result: "degraded" }
    : { id: "anthropic-models", result: "fresh", fetched_at: "2026-10-13", rows },
  executables: [exe], observations: [],
});

test("catalog/2 bundled mappings and null Codex family validate", async () => {
  const r = await resolver();
  const c = catalog();
  assert.equal(r.validateCatalog(c), c);
  assert.deepEqual(c.cli.claude.family_prefixes, [
    mapping("claude-fable-", "fable"), mapping("claude-opus-"),
    mapping("claude-sonnet-", "sonnet"), mapping("claude-haiku-", "haiku"),
  ]);
  assert.equal(c.cli.codex.family_prefixes, null);
  assert.equal(r.modelKey("claude-opus-9[1m]"), "claude-opus-9");
});

test("family fallback promotes by literal prefix after context normalization; nonmatch and degraded keep incumbent", async () => {
  const r = await resolver();
  const c = r.validateCatalog(catalog());
  const fresh = [row("claude-opus-10", "opus")];
  const promoted = r.resolveSpawnDecision(input(c, "claude-opus-9[1m]", fresh));
  assert.equal(promoted.ok, true);
  assert.equal(promoted.decision.model, "claude-opus-10");
  assert.deepEqual(promoted.decision.effort, { channel: "argv:--effort", token: "medium", state: "model-default" });
  assert.equal(promoted.decision.requested.model, "claude-opus-9[1m]");
  assert.match(promoted.decision.evidence_label, /^current-as-of-/);
  assert.match(promoted.decision.rationale, /current opus row claude-opus-10 selected/);
  for (const result of [r.resolveSpawnDecision(input(c, "other-opus-9", fresh)),
    r.resolveSpawnDecision(input(c, "claude-opus-9", null))]) {
    assert.equal(result.ok, true);
    assert.notEqual(result.decision.model, "claude-opus-10");
  }
  const degraded = r.resolveSpawnDecision(input(c, "claude-opus-9", null));
  assert.equal(degraded.decision.model, "claude-opus-9");
  assert.match(degraded.decision.evidence_label, /^degraded:/);
});

test("fresh row tier precedes bootstrap row and family; bootstrap row precedes family", async () => {
  const r = await resolver();
  const c = catalog();
  c.surfaces["anthropic-models"].rows.push(row("claude-opus-old", "sonnet", "legacy"));
  r.validateCatalog(c);
  const fresh = [row("claude-opus-old", "haiku", "legacy"), row("new-haiku", "haiku"),
    row("new-sonnet", "sonnet"), row("new-opus", "opus")];
  assert.equal(r.resolveSpawnDecision(input(c, "claude-opus-old", fresh)).decision.model, "new-haiku");
  assert.equal(r.resolveSpawnDecision(input(c, "claude-opus-old", fresh.slice(1))).decision.model, "new-sonnet");
});

test("explicit model stays verbatim; other-provider observation does not reject it", async () => {
  const r = await resolver();
  const c = r.validateCatalog(catalog());
  const i = input(c, "claude-opus-9", [row("claude-opus-10", "opus")]);
  i.request = { model: { value: "claude-opus-9[1m]", source: "flag" } };
  i.observations = [{ provider: "openai", surface: "codex-cli", model: "claude-opus-9",
    outcome: "rejected-unavailable" }];
  const result = r.resolveSpawnDecision(i);
  assert.equal(result.ok, true);
  assert.equal(result.decision.model, "claude-opus-9[1m]");
  assert.equal(result.decision.requested.model, "claude-opus-9[1m]");
  assert.match(result.decision.rationale, /explicit model claude-opus-9\[1m\] kept verbatim/);
});

test("null and empty family mappings both yield no family match; regex-looking prefixes remain literal", async () => {
  const r = await resolver();
  for (const prefixes of [null, [], [mapping("^claude-opus-")]]) {
    const c = catalog();
    c.cli.claude.family_prefixes = prefixes;
    r.validateCatalog(c);
    const result = r.resolveSpawnDecision(input(c, "claude-opus-9", [row("claude-opus-10", "opus")]));
    assert.equal(result.decision.model, "claude-opus-9");
  }
});

test("catalog/1 and arbitrary family_pattern refuse with migration guidance", async () => {
  const r = await resolver();
  const old = catalog();
  old.schema = "aigentry-model-catalog/1";
  old.cli.claude.family_pattern = "[";
  assert.throws(() => r.validateCatalog(old), /MODEL_CATALOG_INVALID: schema: migrate catalog\/1.*family_pattern/);
  const current = catalog();
  current.cli.claude.family_pattern = "^(a+)+$";
  assert.throws(() => r.validateCatalog(current), /MODEL_CATALOG_INVALID: claude: unsupported field.*family_pattern/);
});

test("literal mapping bounds, exact fields, and overlap are enforced", async () => {
  const r = await resolver();
  const valid = catalog();
  valid.cli.claude.family_prefixes = Array.from({ length: 32 }, (_, n) => mapping(`p${String(n).padStart(2, "0")}-`));
  assert.equal(r.validateCatalog(valid), valid);
  const cases: Array<[string, unknown]> = [
    ["missing", undefined], ["wrong type", "claude-"], ["too many", Array.from({ length: 33 }, (_, n) => mapping(`p${n}-`))],
    ["empty", [mapping("")]], ["overlong", [mapping("a".repeat(201))]],
    ["control", [mapping("a\n")]], ["non-ascii", [mapping("é")]],
    ["leading space", [mapping(" a")]], ["trailing space", [mapping("a ")]],
    ["invalid tier", [{ prefix: "a", tier: "" }]], ["missing tier", [{ prefix: "a" }]],
    ["extra field", [{ prefix: "a", tier: "opus", pattern: ".*" }]],
    ["duplicate", [mapping("a"), mapping("a")]],
    ["overlap", [mapping("abc"), mapping("ab")]],
  ];
  for (const [name, prefixes] of cases) {
    const c = catalog();
    if (prefixes === undefined) delete c.cli.claude.family_prefixes;
    else c.cli.claude.family_prefixes = prefixes;
    assert.throws(() => r.validateCatalog(c), /MODEL_CATALOG_INVALID/, name);
  }
  for (const [field, value] of [["extra top-level", { unexpected: true }], ["extra policy", { extra: true }]] as const) {
    const c = catalog();
    if (field === "extra top-level") Object.assign(c, value);
    else Object.assign(c.cli.claude, value);
    assert.throws(() => r.validateCatalog(c), /MODEL_CATALOG_INVALID/, field);
  }
  const edge = catalog();
  edge.cli.claude.family_prefixes = [mapping("x".repeat(200))];
  assert.equal(r.validateCatalog(edge), edge);
});

test("invalid family_pattern is refused before metadata transport or executable collection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-catalog-v2-"));
  try {
    const c = catalog();
    c.cli.claude.family_pattern = "[";
    const file = join(dir, "invalid.json");
    writeFileSync(file, JSON.stringify(c));
    let calls = 0;
    const result = await (await evidence()).resolveCommand(
      ["--cli", "claude", "--sid", "fixture-sid", "--task", "1223"],
      { HOME: dir, AIGENTRY_HOME: dir, TMPDIR: dir, PATH: "", AIGENTRY_MODEL_METADATA: "off",
        AIGENTRY_CLAUDE_EXECUTABLE: join(dir, "claude") },
      { catalogPath: file, transport: async () => { calls++; throw new Error("metadata called"); } });
    assert.equal(result.code, 10);
    assert.match(result.out, /MODEL_CATALOG_INVALID.*family_pattern/);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed catalog JSON is refused before metadata transport or executable collection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-catalog-v2-"));
  try {
    const file = join(dir, "malformed.json");
    writeFileSync(file, '{"schema":');
    let calls = 0;
    const result = await (await evidence()).resolveCommand(
      ["--cli", "claude", "--sid", "fixture-sid", "--task", "1223"],
      { HOME: dir, AIGENTRY_HOME: dir, TMPDIR: dir, PATH: "", AIGENTRY_MODEL_METADATA: "off",
        AIGENTRY_CLAUDE_EXECUTABLE: join(dir, "claude") },
      { catalogPath: file, transport: async () => { calls++; throw new Error("metadata called"); } });
    assert.equal(result.code, 10);
    assert.match(result.out, /MODEL_CATALOG_INVALID/);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
