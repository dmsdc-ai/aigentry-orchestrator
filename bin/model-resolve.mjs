// #1148 U1 — pure spawn-decision resolver. No I/O, no clock read, no model or
// provider call: every fact (date, catalog, metadata result, executable
// candidates, observations) is an argument, so identical inputs give an
// identical decision. bin/model-evidence.mjs owns the bounded I/O around it.
//
// Selection is a FILTER over documented facts, never a ranking by id text,
// model number, price or source row order:
//   - explicit request (env/flag): kept verbatim; a positively incompatible
//     tuple is refused by name (exit 4), never substituted; an unknown
//     version/band stays explicit-unverified.
//   - auto: the incumbent (route/role-config, else the catalog policy row) is
//     kept unless THIS decision's metadata is fresh, the incumbent is not a
//     current row, and exactly one current row exists in the same documented
//     tier (or a documented replacement is current). Degraded metadata keeps the
//     incumbent and says so. No eligible tuple is exit 10.
//   - effort: explicit token if compatible; else the documented model default
//     if it is in the channel band and not max/ultra/ultracode; else OMIT.
//   - executable: operator-declared first (no fallback), else the first PATH hit
//     not positively excluded (known version below a documented/observed
//     minimum, or an identity-keyed rejection).
//   - retirement: only a definite retire_on / lifecycle retired refuses; a
//     retire_not_before floor that has passed makes the lifecycle unknown (noted,
//     never refused, never an auto-promotion target).

export const REFUSAL = Object.freeze({
  INCOMPATIBLE: { code: "MODEL_TUPLE_INCOMPATIBLE", exit: 4 },
  REQUEST_INVALID: { code: "MODEL_REQUEST_INVALID", exit: 4 },
  NO_ELIGIBLE: { code: "MODEL_NO_ELIGIBLE_TUPLE", exit: 10 },
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Task ids are whatever the scope file binds: non-empty printable, bounded.
const TASK = /^[\x21-\x7e]{1,128}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIFECYCLES = ["current", "legacy", "deprecated", "retired"];
// The executable surface a negative observation must name to affect this CLI's tuple.
// Public catalog surface ids (anthropic-models, …) are documentation, not execution surfaces.
export const EXECUTION_SURFACE = Object.freeze({ claude: "claude-code", codex: "codex-cli" });
const own = (obj, key) => (obj && typeof obj === "object" && Object.hasOwn(obj, key) ? obj[key] : undefined);
// constructor, toString, __proto__, … are never catalog or surface keys.
const prototypeKey = (key) => Object.hasOwn(Object.prototype, key);

/** Printable-ASCII rendering for rationale/refusal text: terminal control bytes never pass. */
export function safeText(value, max = 160) {
  return String(value).replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

export function isToken(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !CONTROL.test(v) && v.trim() === v;
}

/** SemVer core compare, same semantics as boot-adapter/common.ts semverGte. */
export function semverGte(installed, minimum) {
  const parse = (s) => {
    const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)(-[A-Za-z0-9.-]+)?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Boolean(m[4])] : [0, 0, 0, false];
  };
  const [aM, an, ap, apre] = parse(installed);
  const [bM, bn, bp, bpre] = parse(minimum);
  if (aM !== bM) return aM > bM;
  if (an !== bn) return an > bn;
  if (ap !== bp) return ap > bp;
  if (apre === bpre) return true;
  return !apre;
}

/** Catalog lookup key: a Claude Code context suffix such as `[1m]` is not part of the model id. */
export function modelKey(model) {
  return String(model).replace(/\[[^\]]*\]$/, "");
}

function validRow(r) {
  return r && typeof r === "object" && isToken(r.model) && LIFECYCLES.includes(r.lifecycle) &&
    (r.tier === null || r.tier === undefined || isToken(r.tier)) &&
    (r.default_effort === null || r.default_effort === undefined || isToken(r.default_effort)) &&
    (r.retire_on === null || r.retire_on === undefined || DATE.test(r.retire_on)) &&
    (r.retire_not_before === null || r.retire_not_before === undefined || DATE.test(r.retire_not_before)) &&
    (r.labels === undefined || (Array.isArray(r.labels) && r.labels.every(isToken))) &&
    (r.effort_excluded === undefined || (Array.isArray(r.effort_excluded) && r.effort_excluded.every(isToken))) &&
    (r.replacement === undefined || isToken(r.replacement));
}

/** Structural check of docs/model-profiles/model-catalog.json. Returns the catalog or throws. */
export function validateCatalog(c) {
  const bad = (what) => { throw new Error(`MODEL_CATALOG_INVALID: ${what}`); };
  if (!c || typeof c !== "object" || c.schema !== "aigentry-model-catalog/1" || !DATE.test(c.as_of)) bad("header");
  for (const cli of ["claude", "codex"]) {
    const p = own(c.cli, cli);
    if (!p || !isToken(p.provider) || !isToken(p.surface) || prototypeKey(p.surface) || !own(c.surfaces, p.surface) ||
      !isToken(p.policy_incumbent)) bad(cli);
    if (p.effort_band !== null && !(Array.isArray(p.effort_band) && p.effort_band.every(isToken))) bad(`${cli}.effort_band`);
    if (!Array.isArray(p.auto_effort_never) || !p.auto_effort_never.every(isToken)) bad(`${cli}.auto_effort_never`);
    const rows = own(c.surfaces, p.surface).rows;
    if (!Array.isArray(rows) || !rows.every(validRow)) bad(`${p.surface}.rows`);
    // One row per model key: an ambiguous catalog is refused here, never settled by row order.
    const keys = new Set();
    for (const r of rows) {
      if (keys.has(modelKey(r.model))) bad(`duplicate model ${safeText(r.model, 128)} in ${p.surface}`);
      keys.add(modelKey(r.model));
    }
  }
  if (!Array.isArray(c.known_incompatibilities) || !c.known_incompatibilities.every((k) =>
    isToken(k?.cli) && isToken(k?.model) && VERSION.test(k?.min_cli_version ?? ""))) bad("known_incompatibilities");
  return c;
}

function sameIdentity(a, b) {
  return a.realpath === b.realpath && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function refuse(kind, reason) {
  return { ok: false, code: kind.code, exit: kind.exit, reason: safeText(reason, 600) };
}

function publicBinding(e) {
  return { cli: e.cli, path: e.path, realpath: e.realpath, dev: e.dev, ino: e.ino, size: e.size,
    mtimeMs: e.mtimeMs, version: e.version, versionSource: e.versionSource };
}

/**
 * input = {
 *   cli: "claude"|"codex", sid, task, today: "YYYY-MM-DD",
 *   route: null | { model, decided_by }            // null = explicit --cli
 *   explicitCli: boolean,                           // --cli was given by flag
 *   request: { model?: {value, source}, effort?: {value, source}, executable?: {path, source} },
 *   catalog,                                        // validateCatalog() output
 *   surface: { id, result, fetched_at?, final_url?, body_sha256?, rows? },
 *   executables: ExecutableBinding[] (+ declared: true on the operator one), declared first,
 *   executableNotes: string[],                      // collector notes, already printable
 *   observations: Observation[],                    // validated negative observations only
 * }
 * → { ok: true, decision } | { ok: false, code, exit, reason }
 */
export function resolveSpawnDecision(input) {
  const { cli, sid, task, today, route, catalog, surface } = input;
  const request = input.request || {};
  const policy = own(catalog.cli, cli);
  if (!policy || !own(EXECUTION_SURFACE, cli)) return refuse(REFUSAL.REQUEST_INVALID, `unsupported cli ${cli}`);
  if (!IDENTITY.test(sid) || !TASK.test(task) || !DATE.test(today)) return refuse(REFUSAL.REQUEST_INVALID, "sid/task/date");
  for (const [name, r] of Object.entries(request)) {
    const v = name === "executable" ? r?.path : r?.value;
    if (r !== undefined && !isToken(v)) return refuse(REFUSAL.REQUEST_INVALID, `requested ${name} is empty, too long or contains control characters`);
  }
  if (route && !isToken(route.model)) return refuse(REFUSAL.REQUEST_INVALID, "route model");

  const bootstrap = own(catalog.surfaces, policy.surface);
  const fresh = surface && surface.id === policy.surface && surface.result === "fresh" && Array.isArray(surface.rows);
  const freshRows = fresh ? surface.rows.filter(validRow) : [];
  const bootRow = (m) => bootstrap.rows.find((r) => r.model === modelKey(m));
  const freshRow = (m) => freshRows.find((r) => r.model === modelKey(m));
  const factRow = (m) => (fresh ? freshRow(m) : bootRow(m));
  const factSource = fresh ? `fresh ${policy.surface}` : `bootstrap ${catalog.as_of}`;
  const familyPattern = typeof policy.family_pattern === "string" ? new RegExp(policy.family_pattern) : null;
  const tierOf = (m) => factRow(m)?.tier ?? bootRow(m)?.tier ?? (familyPattern?.exec(modelKey(m))?.[1] ?? null);
  // Documented retirement is a hard gate from every source, fresh or not.
  const retired = (m) => [bootRow(m), freshRow(m)].some((r) => r && (r.lifecycle === "retired" ||
    (r.retire_on && r.retire_on <= today)));
  // "Not sooner than D" is a lower bound, never a retirement date: on/after D the source
  // commits to neither continued availability nor retirement, so it is noted, never refused.
  const floorRow = (m) => (fresh && freshRow(m) ? freshRow(m) : bootRow(m));
  const floorPassed = (m) => {
    const d = floorRow(m)?.retire_not_before;
    return d && d <= today ? d : null;
  };
  const floorNote = (m, d) => `${m}: retirement floor 'not sooner than ${d}' ` +
    `(${fresh && freshRow(m) ? factSource : `bootstrap ${catalog.as_of}`}) has passed: continued availability and ` +
    "retirement are both unknown (a floor is not a retirement date)";
  const provider = policy.provider;
  // Negative observations bind provider AND this CLI's execution surface; any other surface is ignored.
  const obs = (input.observations || []).filter((o) => o.provider === provider && o.surface === EXECUTION_SURFACE[cli]);
  const unavailable = (m) => obs.some((o) => o.outcome === "rejected-unavailable" && modelKey(o.model) === modelKey(m));
  const minimums = (m) => [
    ...catalog.known_incompatibilities.filter((k) => k.cli === cli && modelKey(k.model) === modelKey(m)).map((k) => k.min_cli_version),
    ...obs.filter((o) => o.outcome === "rejected-version" && o.min_version && modelKey(o.model) === modelKey(m)).map((o) => o.min_version),
  ];
  const identityRejected = (m, e) => obs.some((o) => o.outcome === "rejected-version" && o.executable &&
    modelKey(o.model) === modelKey(m) && sameIdentity(o.executable, e));
  const band = policy.effort_band;
  // A fresh row that states no default never turns a bootstrap default into a current fact:
  // the value is kept but its dated source is named.
  const effortFact = (m) => {
    const f = fresh ? freshRow(m)?.default_effort ?? null : null;
    if (f !== null) return { value: f, source: factSource };
    const b = bootRow(m)?.default_effort ?? null;
    return { value: b, source: b === null ? null
      : fresh ? `bootstrap ${catalog.as_of}; not stated by fresh ${policy.surface}` : factSource };
  };
  const defaultEffort = (m) => effortFact(m).value;
  const effortRejection = (m, token) => {
    if (defaultEffort(m) === "unsupported") return `effort is documented as not supported for ${m} (source: ${effortFact(m).source})`;
    if (band && !band.includes(token)) return `effort ${token} is not a documented ${policy.effort_channel} level`;
    if ([bootRow(m), freshRow(m)].some((r) => r?.effort_excluded?.includes(token))) return `effort ${token} is documented as excluded for ${m}`;
    if (obs.some((o) => o.outcome === "rejected-effort" && modelKey(o.model) === modelKey(m) && o.effort === token)) {
      return `effort ${token} was rejected for ${m} (operator observation)`;
    }
    return null;
  };

  // Executable: operator-declared only (no substitution), else PATH order.
  const executables = input.executables || [];
  const declared = executables.find((e) => e.declared);
  const pool = declared ? [declared] : executables.filter((e) => !e.declared);
  const pickExecutable = (m) => {
    const skipped = [];
    for (const e of pool) {
      const below = e.version === null ? null : minimums(m).find((min) => !semverGte(e.version, min));
      if (below) { skipped.push(`${e.path} version ${e.version} < ${below} required for ${m}`); continue; }
      if (identityRejected(m, e)) { skipped.push(`${e.path} identity rejected for ${m} (operator observation)`); continue; }
      return { exe: e, skipped };
    }
    return { exe: null, skipped };
  };

  const explicitModel = request.model?.value;
  const explicitEffort = request.effort?.value;
  const incumbent = route ? route.model : policy.policy_incumbent;
  const candidates = [];
  const notes = [];
  if (explicitModel !== undefined) {
    candidates.push(explicitModel);
  } else {
    const incRow = factRow(incumbent);
    if (fresh && incRow?.lifecycle !== "current") {
      const tier = tierOf(incumbent);
      const replacement = [incRow, bootRow(incumbent)].map((r) => r?.replacement).find(Boolean);
      const replacementRow = replacement ? freshRow(replacement) : undefined;
      // A row past its retirement floor has unknown lifecycle: never an auto-promotion target.
      const lapsed = freshRows.filter((r) => r.lifecycle === "current" && r.tier === tier && floorPassed(r.model));
      if (tier && lapsed.length) notes.push(`not promoted (lifecycle unknown past retirement floor): ${lapsed.map((r) => r.model).sort().join(", ")}`);
      const tierRows = tier ? freshRows.filter((r) => r.lifecycle === "current" && r.tier === tier && !retired(r.model) &&
        !floorPassed(r.model)) : [];
      const picked = tierRows.filter((r) => r.labels?.includes("documented-default-pick"));
      const promoted = replacementRow?.lifecycle === "current" && !floorPassed(replacementRow.model) ? replacementRow
        : tierRows.length === 1 ? tierRows[0] : picked.length === 1 ? picked[0] : null;
      if (promoted) {
        candidates.push(promoted.model);
        notes.push(`incumbent ${incumbent} is ${incRow?.lifecycle ?? "not in the parsed current listing"} on fresh ${policy.surface}; ` +
          `current ${tier ?? "documented-replacement"} row ${promoted.model} selected (documented lifecycle, not id order)`);
      } else if (tierRows.length > 1) {
        notes.push(`tier ${tier} has ${tierRows.length} current rows without a rank label: ambiguous, incumbent kept`);
      }
    } else if (!fresh) {
      notes.push(`metadata ${policy.surface} ${surface?.result ?? "absent"}: incumbent kept, no promotion`);
    }
    candidates.push(incumbent);
  }

  const rejections = [];
  for (const model of candidates) {
    if (retired(model)) { rejections.push(`${model} is documented retired on this surface as of ${today}`); continue; }
    if (unavailable(model)) { rejections.push(`${model} was rejected as unavailable (operator observation)`); continue; }
    const floor = floorPassed(model);
    let effort;
    if (explicitEffort !== undefined) {
      const why = effortRejection(model, explicitEffort);
      if (why) { rejections.push(why); continue; }
      effort = { token: explicitEffort, state: !floor && defaultEffort(model) === explicitEffort ? "explicit" : "explicit-unverified" };
    } else {
      const d = defaultEffort(model);
      effort = d && d !== "unsupported" && !policy.auto_effort_never.includes(d) && (!band || band.includes(d))
        ? { token: d, state: "model-default" } : { token: null, state: "omitted" };
    }
    const { exe, skipped } = pickExecutable(model);
    if (!exe) {
      rejections.push(pool.length ? `no compatible ${cli} executable for ${model}: ${skipped.join("; ")}`
        : `no ${cli} executable ${declared ? "declared" : "on PATH"}`);
      continue;
    }
    const row = factRow(model);
    const membership = row ? `listed-${row.lifecycle}` : "not-listed (parsed listing may be incomplete: unknown, not absence)";
    const cliCompat = exe.version === null ? "version-unknown" : minimums(model).length ? "version-known-compatible" : "version-known-no-documented-minimum";
    const requested = { source: "none" };
    if (input.explicitCli) requested.cli = cli;
    if (explicitModel !== undefined) requested.model = explicitModel;
    else if (route) requested.model = route.model;
    if (explicitEffort !== undefined) requested.effort = explicitEffort;
    if (request.executable) requested.executable = request.executable.path;
    const sources = [request.model?.source, request.effort?.source, request.executable?.source].filter(Boolean);
    requested.source = sources.includes("flag") ? "flag" : sources.includes("env") ? "env"
      : route ? "role-config" : input.explicitCli ? "flag" : "none";
    const label = fresh ? `current-as-of-${surface.fetched_at}` : `degraded:${policy.surface}:${surface?.result ?? "absent"}`;
    const parts = [
      explicitModel !== undefined ? `explicit model ${explicitModel} kept verbatim (${request.model.source})`
        : `auto model ${model} (incumbent ${incumbent}, ${route ? "role-config" : "catalog policy"})`,
      ...notes,
      `catalog membership: ${membership} (${factSource}); cli compatibility: ${cliCompat}; account availability: unknown`,
      ...(floor ? [floorNote(model, floor) + (explicitModel !== undefined ? "; explicit request kept unverified" : "")] : []),
      effort.token === null ? `effort omitted (${defaultEffort(model) === "unsupported" ? `documented not supported; source: ${effortFact(model).source}` : "no usable documented default"})`
        : `effort ${effort.token} ${effort.state}` + (effort.state === "model-default" ? ` (source: ${effortFact(model).source})` : ""),
      `executable ${exe.path} -> ${exe.realpath} version ${exe.version ?? "unknown"} (${exe.versionSource})`,
      ...skipped.map((s) => `skipped ${s}`),
      ...(input.executableNotes || []),
      ...rejections.map((r) => `rejected ${r}`),
      "cost impact unknown (not measured; price is not spend authority)",
    ];
    return {
      ok: true,
      decision: {
        v: 1, task, sid, cli, executable: publicBinding(exe),
        model,
        effort: { channel: policy.effort_channel, token: effort.token, state: effort.state },
        requested,
        decided_by: route ? route.decided_by : "explicit",
        evidence_label: safeText(label, 400),
        rationale: safeText(parts.map((p) => safeText(p, 400)).join("; "), 2000),
        observed: { model: null, observed_by: "none" },
      },
    };
  }
  const explicit = explicitModel !== undefined || explicitEffort !== undefined || declared !== undefined;
  return refuse(explicit ? REFUSAL.INCOMPATIBLE : REFUSAL.NO_ELIGIBLE,
    `${cli}: ${rejections.join("; ") || "no candidate"}`);
}
