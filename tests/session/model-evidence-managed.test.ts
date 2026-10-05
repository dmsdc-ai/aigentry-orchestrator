// #1148 — maintained, auto-discovered home for the model-evidence controls that used to live only in
// out-of-tree runners (tests-r13 / tests-r14 imported `../../tests-r11c/...` fixture paths and were never
// discovered). Oracles are the pre-registered ones, unchanged: R14 occurrence controls §1–§8, the R13
// claimless NS1/NS2, ADV1 kept as a REJECT oracle (closed grammar, integration §6), NA3 kept as an
// explicitly UNSUPPORTED known residual (todo, never rewritten), plus fake-transport metadata and
// executable-collection controls for contract/delta.md §3/§5/§6 U1. In-process network is trapped:
// any real socket attempt is recorded and fails the run.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import tls from "node:tls";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Untyped exports of the shipped .mjs modules.
type Rec = Record<string, any>;
const REPO = resolve(import.meta.dirname, "../../..");
let modPromise: Promise<Rec> | undefined;
const evidence = (): Promise<Rec> => (modPromise ??= import(pathToFileURL(join(REPO, "bin/model-evidence.mjs")).href) as Promise<Rec>);

// ── network trap ──────────────────────────────────────────────────────────
const netAttempts: string[] = [];
const restore: Array<() => void> = [];
before(() => {
  const trap = (name: string, obj: Rec, key: string) => {
    const original = obj[key];
    obj[key] = (...args: unknown[]) => {
      netAttempts.push(`${name}.${key} ${String(args[0]).slice(0, 120)}`);
      throw new Error(`TEST NETWORK TRAP: ${name}.${key}`);
    };
    restore.push(() => { obj[key] = original; });
  };
  for (const [name, obj, keys] of [["https", https, ["request", "get"]], ["http", http, ["request", "get"]],
    ["net", net, ["connect", "createConnection"]], ["tls", tls, ["connect"]]] as const) for (const k of keys) trap(name, obj as unknown as Rec, k);
  trap("globalThis", globalThis as unknown as Rec, "fetch");
  syncBuiltinESMExports();
});
after(() => {
  for (const r of restore) r();
  syncBuiltinESMExports();
});

// ── R14 occurrence controls (ported from tests-r14/session/r14-occurrence-controls.test.mjs, oracles unchanged) ──
const A = "gpt-5.4", N = "gpt-6-sol", M = "gpt-5.2", G = "gpt-5.3-codex";
const D = "2030-06-01", DT = "June 1, 2030";
const q = (x: string) => `\`${x}\``;
const show = (x: unknown) => JSON.stringify(x);
const REC = (extra: string[] = []) => ["## Recommended models", "", `Select ${[N, ...extra].map(q).join(" or ")}.`, ""];
let parseCodexModels: (md: string) => Rec[] | null;
before(async () => { parseCodexModels = (await evidence()).parseCodexModels; });
const prose = (paras: string[], extraRec: string[] = []) => parseCodexModels(["## Deprecated models", "", ...paras.flatMap((p) => [p, ""]), ...REC(extraRec)].join("\n"));
const table = (rows: string[], { crlf = false } = {}) => {
  const s = ["## Deprecated models", "", "| Model | Status | Notes |", "|:--|:--|:--|", ...rows, "", ...REC()].join("\n");
  return parseCodexModels(crlf ? s.replace(/\n/g, "\r\n") : s);
};
const pick = (rows: Rec[] | null, m: string) => rows?.find((r) => r.model === m);
const undated = (r: Rec) => r.retire_on === null && r.retire_not_before === null;
const SUBJ = `The ${q(A)} model is deprecated.`;
const MIG = `Migrate your requests to ${q(N)}.`;

// KEEP: page kept; exactly the listed deprecated ids with their dates (null = undated; an array = any of those values);
// N (and `cur`) current; every other row undated and current.
const keep = (rows: Rec[] | null, dep: Record<string, string | null | Array<string | null>>, cur: string[] = []) => {
  assert.ok(rows, "page rejected (null)");
  for (const [m, d] of Object.entries(dep)) {
    const r = pick(rows, m);
    assert.ok(r, `${m} missing in ${show(rows)}`);
    assert.equal(r.lifecycle, "deprecated", `${m} ${show(r)}`);
    if (Array.isArray(d)) assert.ok(d.includes(r.retire_on), `${m} ${show(r)}`); else assert.equal(r.retire_on, d, `${m} ${show(r)}`);
    assert.equal(r.retire_not_before, null, `${m} ${show(r)}`);
  }
  for (const r of rows) if (!Object.hasOwn(dep, r.model)) {
    assert.ok(undated(r), `date leaked to ${show(r)}`);
    assert.equal(r.lifecycle, "current", `unexpected non-current ${show(r)}`);
  }
  for (const m of [N, ...cur]) assert.equal(pick(rows, m)?.lifecycle, "current", `${m} ${show(pick(rows, m))}`);
};
const reject = (rows: Rec[] | null) => assert.equal(rows, null, `expected REJECT (genuine conflict), got ${show(rows)}`);

describe("R14 §1 mixed quoted/unquoted occurrence (R13 HOLD-1 class)", () => {
  test("A1 QU1 Replace `N` with N → REJECT", () => reject(prose([`Replace ${q(N)} with ${N}.`])));
  test("A2 QU2 Replace `A` with A → A deprecated", () => {
    const rows = prose([`Replace ${q(A)} with ${A}.`]);
    if (rows === null) return; // fail-closed tolerated (as in the R13 file)
    assert.equal(pick(rows, A)?.lifecycle, "deprecated", `A dropped: ${show(rows)}`);
    assert.ok(undated(pick(rows, A)!), show(rows));
  });
  test("A3 QU3 Replace `A` with N and `N` with G → REJECT", () => reject(prose([`Replace ${q(A)} with ${N} and ${q(N)} with ${G}.`])));
  test("A4 QU6 `N` deprecated; migrate to N → REJECT", () => reject(prose([`The ${q(N)} model is deprecated; migrate your requests to ${N}.`])));
  test("A5 QU7 Replace `M` with A; the `A` model is deprecated on D", () => keep(prose([`Replace ${q(M)} with ${A}; the ${q(A)} model is deprecated on ${DT}.`]), { [A]: [null, D], [M]: null }));
  test("A6 QU8 Replace `M` with A; the `A` model is deprecated", () => keep(prose([`Replace ${q(M)} with ${A}; the ${q(A)} model is deprecated.`]), { [A]: null, [M]: null }));
  test("A7 QU1d dated ¶ fallback: Replace `N` with N → REJECT", () => reject(prose([`The ${q(A)} model is deprecated on ${DT}. Replace ${q(N)} with ${N}.`])));
  test("A8 QU1d same sentence: ; replace `N` with N → REJECT", () => reject(prose([`The ${q(A)} model is deprecated on ${DT}; replace ${q(N)} with ${N}.`])));
  test("A10 dated ¶ fallback: unquoted N cannot discount a different quoted `M`", () => keep(prose([`The ${q(A)} model is deprecated on ${DT}. Replace ${q(M)} with ${N}.`]), { [A]: D, [M]: null }));
  test("A11 QU4 Replace A with `N`", () => keep(prose([`Replace ${A} with ${q(N)}.`]), {}));
  test("A12 QU5 Replace `A` with N", () => keep(prose([`Replace ${q(A)} with ${N}.`]), { [A]: null }));
});

describe("R14 §2 table cells: claims and claimless NOTEs", () => {
  test("B1 claimless cell Replace `N` with N → REJECT", () => reject(table([`| ${q(A)} | - | Replace ${q(N)} with ${N}. |`])));
  test("B2 dated cell claim; replace `N` with N → REJECT", () => reject(table([`| ${q(A)} | Retired on ${DT}; replace ${q(N)} with ${N} | - |`])));
  test("B3 claimless cell unquoted target", () => keep(table([`| ${q(A)} | - | Migrate your requests to ${N}. |`]), { [A]: null }));
  test("B4 dated cell claim unquoted target", () => keep(table([`| ${q(A)} | Retired on ${DT}; migrate your requests to ${N} | - |`]), { [A]: D }));
  test("B5 dated cell, quoted slot in later sentence", () => keep(table([`| ${q(A)} | Retired on ${DT}. ${MIG} | - |`]), { [A]: D }));
  test("B6 claimless cell **`N`**", () => keep(table([`| ${q(A)} | - | Migrate your requests to **${q(N)}**. |`]), { [A]: null }));
  test("B7 claimless cell [`N`](url)", () => keep(table([`| ${q(A)} | - | Migrate your requests to [${q(N)}](https://x/y). |`]), { [A]: null }));
  test("B8 claimless cell two NOTE clauses, quoted", () => keep(table([`| ${q(A)} | - | Replace ${q(M)} with ${q(N)}; migrate your requests to ${q(N)}. |`]), { [A]: null, [M]: null }));
  test("B9 claimless cell two NOTE clauses, first unquoted", () => keep(table([`| ${q(A)} | - | Replace ${q(M)} with ${N}; migrate your requests to ${q(N)}. |`]), { [A]: null, [M]: null }));
  test("B10 same id subject+target in a row → REJECT", () => reject(table([`| ${q(N)} | - | ${MIG} |`])));
  test("B12 dated cell + claimless cell Replace `N` with N → REJECT", () => reject(table([`| ${q(A)} | Retired on ${DT} | Replace ${q(N)} with ${N}. |`])));
});

describe("R14 §3 subjectless prose claims", () => {
  test("C1 Retired on D; replace `N` with N → REJECT", () => reject(prose([`Retired on ${DT}; replace ${q(N)} with ${N}.`])));
  test("C2 Retired on D; migrate to `N`", () => keep(prose([`Retired on ${DT}; migrate your requests to ${q(N)}.`]), {}));
  test("C3 Retired on D. Replace `N` with N → REJECT", () => reject(prose([`Retired on ${DT}. Replace ${q(N)} with ${N}.`])));
  test("C4 Retired on D. Migrate to `N`", () => keep(prose([`Retired on ${DT}. ${MIG}`]), {}));
});

describe("R14 §4 same-id subject+target stays fail-closed", () => {
  test("D1 `N` deprecated on D. Migrate to `N` → REJECT", () => reject(prose([`The ${q(N)} model is deprecated on ${DT}. ${MIG}`])));
  test("D2 `N` deprecated on D; migrate to `N` → REJECT", () => reject(prose([`The ${q(N)} model is deprecated on ${DT}; migrate your requests to ${q(N)}.`])));
  test("D3 Replace `N` with `N`; migrate to `N` → REJECT", () => reject(prose([`Replace ${q(N)} with ${q(N)}; migrate your requests to ${q(N)}.`])));
});

describe("R14 §5 legitimate PR1 mixed targets stay usable", () => {
  test("E1 SUBJ. Migrate to N", () => keep(prose([`${SUBJ} Migrate your requests to ${N}.`]), { [A]: null }));
  test("E2 SUBJ; migrate to N", () => keep(prose([`The ${q(A)} model is deprecated; migrate your requests to ${N}.`]), { [A]: null }));
  test("E3 Replace `A` with N and `M` with `N`", () => keep(prose([`Replace ${q(A)} with ${N} and ${q(M)} with ${q(N)}.`]), { [A]: null, [M]: null }));
  test("E4 dated SUBJ. Migrate to N", () => keep(prose([`The ${q(A)} model is deprecated on ${DT}. Migrate your requests to ${N}.`]), { [A]: D }));
  test("E5 Replace `A` with N and `M` with `N` (record copy)", () => keep(prose([`Replace ${q(A)} with ${N} and ${q(M)} with ${q(N)}.`]), { [A]: null, [M]: null }));
  test("E6 retired on D in favor of `N`", () => keep(prose([`The ${q(A)} model is retired on ${DT} in favor of ${q(N)}.`]), { [A]: D }));
  test("E7 retired on D in favor of N", () => keep(prose([`The ${q(A)} model is retired on ${DT} in favor of ${N}.`]), { [A]: D }));
});

describe("R14 §6 exact positional controls", () => {
  test("F1 **`N`**", () => keep(prose([`Replace ${q(A)} with **${q(N)}**.`]), { [A]: null }));
  test("F2 [`N`](url)", () => keep(prose([`Replace ${q(A)} with [${q(N)}](https://x/y).`]), { [A]: null }));
  test("F3 ws runs + tab", () => keep(prose([`Replace   ${q(A)}   with\t${q(N)}.`]), { [A]: null }));
  test("F4 NBSP", () => keep(prose([`Replace ${q(A)} with ${q(N)}.`]), { [A]: null }));
  test("F5 _`N`_", () => keep(prose([`Replace ${q(A)} with _${q(N)}_.`]), { [A]: null }));
  test("F6 CRLF wrapped sentence", () => keep(parseCodexModels(`## Deprecated models\r\n\r\nReplace ${q(A)}\r\nwith ${q(N)}.\r\n\r\n## Recommended models\r\n\r\nSelect ${q(N)}.\r\n`), { [A]: null }));
  test("F7 Replace `A` with `N`. Replace `N` with N → REJECT", () => reject(prose([`Replace ${q(A)} with ${q(N)}. Replace ${q(N)} with ${N}.`])));
  test("F8 Replace `A` with `N` and `N` with G → REJECT", () => reject(prose([`Replace ${q(A)} with ${q(N)} and ${q(N)} with ${G}.`])));
  test("F9 link around date, quoted slot", () => keep(prose([`The ${q(A)} model is deprecated on [${DT}](https://x/y). ${MIG}`]), { [A]: D }));
  test("F10 emphasis around date and slot", () => keep(prose([`The ${q(A)} model is deprecated on **${DT}**. Migrate your requests to **${q(N)}**.`]), { [A]: D }));
  test("F11 dated; link around slot", () => keep(prose([`The ${q(A)} model is deprecated on ${DT}; migrate your requests to [${q(N)}](https://x/z).`]), { [A]: D }));
  test("F12 ws runs across a dated ¶", () => keep(prose([`The ${q(A)}  model   is deprecated on ${DT}.  Migrate   your requests to ${q(N)}.`]), { [A]: D }));
  test("F14 link in a following NOTE shifts the slot offset", () => keep(prose([`The ${q(A)} model is deprecated on ${DT}. See [the guide](https://x/y). ${MIG}`]), { [A]: D }));
});

describe("R14 §7 row / paragraph / cell / sentence boundaries", () => {
  test("G1 ¶ quoted slot, ¶ Replace `N` with N → REJECT", () => reject(prose([`Replace ${q(A)} with ${q(N)}.`, `Replace ${q(N)} with ${N}.`])));
  test("G2 ¶ unquoted slot, ¶ `N` deprecated → REJECT", () => reject(prose([`Replace ${q(A)} with ${N}.`, `The ${q(N)} model is deprecated.`])));
  test("G3 ¶ unquoted NOTE, ¶ quoted slot", () => keep(prose([`Migrate your requests to ${N}.`, `Replace ${q(A)} with ${q(N)}.`]), { [A]: null }));
  test("G4 two rows quoted / unquoted NOTE", () => keep(table([`| ${q(A)} | - | ${MIG} |`, `| ${q(M)} | - | Migrate your requests to ${N}. |`]), { [A]: null, [M]: null }));
  test("G5 row unquoted NOTE, next row `N` → REJECT", () => reject(table([`| ${q(A)} | - | Migrate your requests to ${N}. |`, `| ${q(N)} | - | - |`])));
  test("G6 unquoted slot cell, `N` in next cell → REJECT", () => reject(table([`| ${q(A)} | Migrate your requests to ${N}. | ${q(N)} |`])));
  test("G7 same quoted NOTE in two cells", () => keep(table([`| ${q(A)} | ${MIG} | ${MIG} |`]), { [A]: null }));
  test("G8 unquoted NOTE then See the `N` guide → REJECT", () => reject(prose([`${SUBJ} Migrate your requests to ${N}. See the ${q(N)} migration guide.`])));
  test("G9 unquoted slot sentence then quoted slot sentence", () => keep(prose([`Replace ${q(A)} with ${N}. ${MIG}`]), { [A]: null }));
});

describe("R14 §8 dash-list structural strip (HOLD-2): positive and negative scope", () => {
  test("H1 IL1 - list", () => keep(prose([`- ${SUBJ}\n- ${MIG}`]), { [A]: null }));
  test("H2 + list", () => keep(prose([`+ ${SUBJ}\n+ ${MIG}`]), { [A]: null }));
  test("H3 -<TAB> list", () => keep(prose([`- ${SUBJ}\n-\t${MIG}`]), { [A]: null }));
  test("H4 IL5 dated item then NOTE item", () => keep(prose([`- The ${q(A)} model is deprecated on ${DT}.\n- ${MIG}`]), { [A]: D }));
  test("H5 - Replace `A` with `N`", () => keep(prose([`- Replace ${q(A)} with ${q(N)}.`]), { [A]: null }));
  test("H6 - list unquoted target", () => keep(prose([`- ${SUBJ}\n- Migrate your requests to ${N}.`]), { [A]: null }));
  test("H7 - Replace `N` with N → REJECT", () => reject(prose([`- Replace ${q(N)} with ${N}.`])));
  test("H8 - `N` deprecated / - migrate to `N` → REJECT", () => reject(prose([`- The ${q(N)} model is deprecated.\n- ${MIG}`])));
  test("H9 -Migrate (no space, not a list) → REJECT", () => reject(prose([SUBJ, `-${MIG}`])));
  test("H10 -- Migrate → REJECT", () => reject(prose([SUBJ, `-- ${MIG}`])));
  test("H11 — Migrate (em dash) → REJECT", () => reject(prose([SUBJ, `— ${MIG}`])));
  test("H12 - - Migrate (double marker) → REJECT", () => reject(prose([SUBJ, `- - ${MIG}`])));
  test("H13 mid-paragraph ' - Migrate' → REJECT", () => reject(prose([`${SUBJ} - ${MIG}`])));
  test("H14 table cell '- Migrate' (bindRow unchanged) → REJECT", () => reject(table([`| ${q(A)} | - | - ${MIG} |`])));
  test("H15 * list (control)", () => keep(prose([`* ${SUBJ}\n* ${MIG}`]), { [A]: null }));
  test("H16 1. list (control)", () => keep(prose([`1. ${SUBJ}\n2. ${MIG}`]), { [A]: null }));
  test("H18 - Consider `N` (unsupported in a list) → REJECT", () => reject(prose([`- ${SUBJ}\n- Consider ${q(N)}.`])));
});

describe("closed grammar: slotless See/admin NOTEs (R13 NS1/NS2, ADV1)", () => {
  test("NS1 admin must enable N (no slot) → REJECT", () => reject(prose([`${SUBJ} An administrator must enable ${q(N)} first.`])));
  test("NS2 see the N migration guide (no slot) → REJECT", () => reject(prose([`${SUBJ} See the ${q(N)} migration guide.`])));
  // ADV1 (r14-independent advisory, integration §6): the refusal follows the closed grammar — kept as a REJECT oracle.
  test("ADV1 dated ¶ + slotless See NOTE quoting the slot id → REJECT (fail-closed, no date, no false current)", () =>
    reject(prose([`The ${q(A)} model is deprecated on ${DT}; migrate your requests to ${q(N)}. See the ${q(N)} migration guide.`])));
  test("ADV1 admin variant → REJECT", () =>
    reject(prose([`The ${q(A)} model is deprecated on ${DT}; migrate your requests to ${q(N)}. An administrator must enable ${q(N)} first.`])));
});

describe("NA3 underscore-emphasised date: UNSUPPORTED known residual (not claimed fixed)", () => {
  const GD = "2030-07-15";
  const GOOD = `| ${q(G)} | Retired on July 15, 2030; migrate your requests to ${q(N)} | - |`;
  const na3 = () => table([`| ${q(A)} | Retired on _June 1, 2030_ | - |`, GOOD]);
  // The pre-registered R13 oracle, preserved verbatim as a todo: it is expected to stay red until the
  // grammar is deliberately extended. A todo failure does not fail the run and is reported as such.
  test("NA3 underscore emphasis date (recorded unsupported grammar)", { todo: "NA3 unsupported grammar: kept red, never rewritten" },
    () => keep(na3(), { [A]: D, [G]: GD }));
  test("NA3 safe refusal: no fabricated date and never current", () => {
    const rows = na3();
    if (rows === null) return; // a page rejection is also safe
    const a = pick(rows, A)!;
    assert.ok(a, show(rows));
    assert.deepEqual([a.retire_on, a.retire_not_before], [null, null], `no fabricated date: ${show(a)}`);
    assert.notEqual(a.lifecycle, "current", show(a));
    assert.equal(pick(rows, G)?.retire_on, GD, "the supported row in the same page keeps its date");
  });
});

// ── fresh public metadata through an injected fake transport (no network) ──
const anthropicPage = (current: Array<[string, string]>, legacy: string[] = ["claude-opus-5"]) => [
  "# Models overview", "", "## Latest models", "",
  `| Feature | ${current.map((_, i) => `M${i}`).join(" | ")} |`, `|:--|${current.map(() => ":--").join("|")}|`,
  `| Claude API ID | ${current.map(([id]) => q(id)).join(" | ")} |`,
  `| Default effort | ${current.map(([, e]) => e).join(" | ")} |`, "",
  "## Legacy models", "", `| Feature | ${legacy.map((_, i) => `L${i}`).join(" | ")} |`, `|:--|${legacy.map(() => ":--").join("|")}|`,
  `| Claude API ID | ${legacy.map(q).join(" | ")} |`, "",
].join("\n");

describe("U1 resolver with fake fresh metadata (selection semantics, delta §5)", () => {
  let dir = "";
  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "model-evidence-1148-")));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/claude"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = () => new Date("2026-10-05T00:00:00.000Z");
  type Transport = (url: string, o: Rec) => Promise<unknown>;
  // `transport: "real"` keeps the shipped https transport (only for paths that must refuse before any socket).
  async function resolveWith(page: string | null, opts: { env?: Record<string, string>; route?: string; transport?: Transport | "real" } = {}) {
    const calls: string[] = [];
    const base = opts.transport ?? (async () => ({ status: 200, headers: { "content-type": "text/markdown; charset=utf-8" }, body: Buffer.from(page ?? "") }));
    const deps: Rec = { now: NOW };
    if (base !== "real") deps.transport = async (url: string, o: Rec) => { calls.push(url); return base(url, o); };
    const argv = ["--cli", "claude", "--sid", "fixture-sid", "--task", "1083",
      "--route-json", JSON.stringify({ model: opts.route ?? "claude-opus-5[1m]", decided_by: "table" })];
    const { code, out } = await (await evidence()).resolveCommand(argv, { PATH: join(dir, "bin"), ...opts.env }, deps);
    return { code: code as number, out: JSON.parse(out) as Rec, calls };
  }

  test("one current row in the incumbent's documented tier is promoted; labelled current-as-of-T", async () => {
    const { code, out, calls } = await resolveWith(anthropicPage([["claude-opus-5-5", "medium"], ["claude-sonnet-5", "high"]]));
    assert.equal(code, 0, show(out));
    assert.ok(calls.length >= 1 && calls.length <= 2 && calls.every((u) => new URL(u).hostname === "platform.claude.com"), show(calls));
    assert.equal(out.decision.model, "claude-opus-5-5");
    assert.equal(out.decision.effort.token, "medium");
    assert.match(out.decision.evidence_label, /^current-as-of-/);
    assert.deepEqual(out.decision.observed ?? { model: null, observed_by: "none" }, { model: null, observed_by: "none" });
  });

  test("source-order shuffle of the page does not change the selection", async () => {
    const a = await resolveWith(anthropicPage([["claude-opus-5-5", "medium"], ["claude-sonnet-5", "high"]], ["claude-opus-5", "claude-opus-4-8"]));
    const b = await resolveWith(anthropicPage([["claude-sonnet-5", "high"], ["claude-opus-5-5", "medium"]], ["claude-opus-4-8", "claude-opus-5"]));
    assert.equal(a.code, 0);
    assert.deepEqual([b.code, b.out.decision.model, b.out.decision.effort], [a.code, a.out.decision.model, a.out.decision.effort]);
  });

  test("several unranked current rows in a tier (e.g. a cheaper one) → ambiguous: incumbent kept, never auto-latest", async () => {
    for (const rows of [[["claude-opus-5-5", "medium"], ["claude-opus-5-7", "low"]], [["claude-opus-5-7", "low"], ["claude-opus-5-5", "medium"]]] as Array<Array<[string, string]>>) {
      const { code, out } = await resolveWith(anthropicPage(rows));
      assert.equal(code, 0, show(out));
      assert.equal(out.decision.model, "claude-opus-5[1m]", show(out.decision));
    }
  });

  test("a current incumbent is kept even when a newer-looking row is listed", async () => {
    const { out } = await resolveWith(anthropicPage([["claude-opus-5-5", "medium"], ["claude-opus-5-9", "low"]]), { route: "claude-opus-5-5" });
    assert.equal(out.decision.model, "claude-opus-5-5");
  });

  for (const [name, env] of [["metadata off", { AIGENTRY_MODEL_METADATA: "off" }], ["unlimited budget", { AIGENTRY_CATALOG_REVALIDATE_MS: "unlimited" }],
    ["NaN budget", { AIGENTRY_CATALOG_MAX_BYTES: "NaN" }], ["proxy configured", { HTTPS_PROXY: "http://127.0.0.1:9" }]] as const) {
    test(`${name} → no fetch, degraded label, incumbent kept`, async () => {
      const transport: Transport | "real" = name === "proxy configured" ? "real" : async () => assert.fail("transport must not be called");
      const { code, out, calls } = await resolveWith(anthropicPage([["claude-opus-5-5", "medium"]]), { env, transport });
      assert.equal(code, 0, show(out));
      assert.deepEqual(calls, []);
      assert.match(out.decision.evidence_label, /^degraded:/);
      assert.equal(out.decision.model, "claude-opus-5[1m]");
    });
  }

  test("failed, oversized, redirected-away and hung fetches degrade within the deadline", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const variants: Array<[string, Transport]> = [
      ["throws", async () => { throw new Error("offline"); }],
      ["too large", async () => ({ status: 200, headers: { "content-type": "text/markdown" }, body: big })],
      ["foreign redirect", async () => ({ status: 302, headers: { location: "https://evil.example/models.md" }, body: Buffer.alloc(0) })],
      ["html block page", async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html>blocked</html>") })],
      ["hang", (_u, o) => new Promise((_, rej) => (o.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted"))))],
    ];
    for (const [name, transport] of variants) {
      const started = Date.now();
      const { code, out, calls } = await resolveWith(null, { transport });
      assert.equal(code, 0, `${name}: ${show(out)}`);
      assert.match(out.decision.evidence_label, /^degraded:/, name);
      assert.equal(out.decision.model, "claude-opus-5[1m]", name);
      assert.ok(calls.every((u) => new URL(u).hostname === "platform.claude.com"), `${name}: ${show(calls)}`);
      assert.ok(calls.length <= 1, `${name}: at most one GET per surface per spawn: ${show(calls)}`);
      assert.ok(Date.now() - started < 5000, `${name}: bounded by the 2500 ms step deadline`);
    }
  });
});

describe("U1 executable collection (stat/realpath/package.json only; nothing executed)", () => {
  let dir = "";
  before(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "model-exe-1148-"))); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("every distinct PATH hit in order; npm version only via a package bin that resolves exactly; native unknown", async () => {
    const tripwire = join(dir, "ran");
    const fake = (file: string) => writeFileSync(file, `#!/bin/sh\necho ran >> '${tripwire}'\n`, { mode: 0o755 });
    const pkg = join(dir, "npm/lib/node_modules/@anthropic-ai/claude-code");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(dir, "npm/bin"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.198", bin: { claude: "cli.js" } }));
    fake(join(pkg, "cli.js"));
    symlinkSync(join(pkg, "cli.js"), join(dir, "npm/bin/claude"));
    mkdirSync(join(dir, "native/versions"), { recursive: true });
    mkdirSync(join(dir, "native/bin"));
    fake(join(dir, "native/versions/2.1.283"));
    symlinkSync(join(dir, "native/versions/2.1.283"), join(dir, "native/bin/claude"));
    mkdirSync(join(dir, "dup"));
    symlinkSync(join(dir, "native/versions/2.1.283"), join(dir, "dup/claude"));
    const pathValue = ["relative/bin", join(dir, "npm/bin"), join(dir, "dup"), join(dir, "native/bin")].join(delimiter);
    const { executables, error } = (await evidence()).collectExecutables("claude", { pathValue });
    assert.equal(error, undefined);
    assert.deepEqual(executables.map((e: Rec) => [e.path, e.realpath, e.version, e.versionSource]), [
      [join(dir, "npm/bin/claude"), join(pkg, "cli.js"), "2.1.198", "npm-package-metadata"],
      [join(dir, "dup/claude"), join(dir, "native/versions/2.1.283"), null, "unknown"],
    ], "distinct realpaths only, PATH order, no name-derived version, relative entry skipped");
    const bad = (await evidence()).collectExecutables("claude", { pathValue, declaredPath: join(dir, "native/versions/2.1.283") });
    assert.ok(bad.error, "a declared path whose basename is not the cli is refused");
    assert.throws(() => realpathSync(tripwire), "nothing was executed");
  });
});

test("no network attempts", () => assert.deepEqual(netAttempts, []));
