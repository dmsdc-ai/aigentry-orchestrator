// #1148 U1 — bounded I/O around the pure resolver (bin/model-resolve.mjs).
//
//   collectExecutables  every distinct PATH hit for the CLI, by stat/realpath and a
//                       bounded package.json read only. Nothing is ever executed:
//                       no --version, --help, login or model list.
//   readObservations    per-call --observe files: bounded, validated NEGATIVE
//                       observations only. Never a worker ACK, never free text.
//   fetchSurface        one public GET per surface per decision to a fixed official
//                       URL: https only, exact host allowlist, no userinfo, no
//                       cookie/auth/body, no proxy bypass, finite whole-step
//                       deadline, bounded body and redirects. Nothing is persisted.
//   resolveCommand      `model-router.mjs --resolve …`: gathers the above and
//                       returns the pure decision (or a named refusal) as one line.
//
// Test seams are function arguments (transport, now, catalogPath), not env: there
// is no environment switch that authorizes another URL or runs a script.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isToken, resolveSpawnDecision, safeText, validateCatalog } from "./model-resolve.mjs";

export const DEFAULT_CATALOG = fileURLToPath(new URL("../docs/model-profiles/model-catalog.json", import.meta.url));

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// ── catalog ─────────────────────────────────────────────────────────────────
export function loadCatalog(file = DEFAULT_CATALOG) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > 1024 * 1024) throw new Error("MODEL_CATALOG_INVALID: size");
  return validateCatalog(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * The legacy router classifier is never called on or after the catalog's existing
 * conservative no-call cutoff (`classifier.retire_on`). That date is the model's documented
 * "not sooner than" floor reused as a cutoff, NOT an official retirement fact; it is never
 * extended. An unreadable catalog or a different model fails closed (no call).
 */
export function classifierRetired(model, now = new Date(), file = DEFAULT_CATALOG) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c?.classifier?.model !== model || !/^\d{4}-\d{2}-\d{2}$/.test(c.classifier.retire_on)) return true;
    return now.toISOString().slice(0, 10) >= c.classifier.retire_on;
  } catch {
    return true;
  }
}

// ── executables ─────────────────────────────────────────────────────────────
/** `package.json` version only when that package's `bin` resolves to exactly this realpath. */
export function npmPackageVersion(realpath, cli, fsImpl = fs) {
  let dir = path.dirname(realpath);
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, "package.json");
    try {
      const st = fsImpl.statSync(file);
      if (st.isFile() && st.size <= 256 * 1024) {
        const pkg = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        const rel = typeof pkg?.bin === "string"
          ? (String(pkg.name ?? "").split("/").pop() === cli ? pkg.bin : null)
          : pkg?.bin && typeof pkg.bin === "object" ? pkg.bin[cli] : null;
        if (typeof rel === "string" && typeof pkg.version === "string" && VERSION.test(pkg.version) &&
          fsImpl.realpathSync(path.resolve(dir, rel)) === realpath) return pkg.version;
      }
    } catch { /* not this ancestor */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * AIGENTRY_<CLI>_EXECUTABLE_VERSION: compact JSON {version, dev, ino, size, mtimeMs}
 * naming the declared file's identity. Anything else is not a declaration.
 */
export function parseDeclaredVersion(raw) {
  try {
    const v = JSON.parse(raw);
    const n = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
    if (v && typeof v === "object" && VERSION.test(v.version ?? "") && n(v.dev) && n(v.ino) && n(v.size) && n(v.mtimeMs) &&
      Object.keys(v).every((k) => ["version", "dev", "ino", "size", "mtimeMs"].includes(k))) return v;
  } catch { /* not JSON */ }
  return null;
}

/**
 * Every distinct (by realpath) executable named `cli` on the given PATH, in PATH
 * order, plus the operator-declared one first when set. Relative PATH entries are
 * skipped (a cwd-relative hit is not a stable identity).
 * → { executables, notes, error? }  error = the declared executable is unusable.
 */
export function collectExecutables(cli, { pathValue = "", declaredPath, declaredVersion, fsImpl = fs } = {}) {
  const executables = [], notes = [], seen = new Set();
  const bind = (p) => {
    const realpath = fsImpl.realpathSync(p);
    const st = fsImpl.statSync(realpath);
    if (!st.isFile()) throw new Error("not a regular file");
    fsImpl.accessSync(realpath, fs.constants.X_OK);
    const version = npmPackageVersion(realpath, cli, fsImpl);
    return { cli, path: p, realpath, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs,
      version, versionSource: version ? "npm-package-metadata" : "unknown" };
  };
  if (declaredPath !== undefined) {
    if (typeof declaredPath !== "string" || !path.isAbsolute(declaredPath) || CONTROL.test(declaredPath) ||
      path.basename(declaredPath) !== cli) {
      return { executables, notes, error: `declared executable must be an absolute path whose basename is ${cli}` };
    }
    let b;
    try { b = bind(declaredPath); } catch { return { executables, notes, error: "declared executable is not an executable regular file" }; }
    if (declaredVersion !== undefined) {
      const d = parseDeclaredVersion(declaredVersion);
      if (!d) notes.push("operator version declaration malformed: version unknown");
      else if (d.dev !== b.dev || d.ino !== b.ino || d.size !== b.size || d.mtimeMs !== b.mtimeMs) {
        notes.push("operator version declaration ignored: declared identity differs from the current file");
      } else if (b.versionSource === "unknown") {
        b.version = d.version;
        b.versionSource = "operator-declared";
      }
    }
    executables.push({ ...b, declared: true });
    seen.add(b.realpath);
  }
  for (const dir of String(pathValue).split(path.delimiter).slice(0, 256)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, cli);
    try {
      fsImpl.accessSync(p, fs.constants.X_OK);
      const b = bind(p);
      if (seen.has(b.realpath)) continue;
      seen.add(b.realpath);
      executables.push(b);
    } catch { continue; }
    if (executables.length >= 16) break;
  }
  return { executables, notes };
}

// ── observations ────────────────────────────────────────────────────────────
const LAUNCH_FAILURE = /^API 400: Claude Code (\d+\.\d+\.\d+) requires (\d+\.\d+\.\d+) or newer for (?:requested )?(claude-[a-z0-9-]+(?:\[[a-z0-9]+\])?)$/;
const OUTCOMES = ["rejected-version", "rejected-unavailable", "rejected-effort"];

/**
 * One value → validated negative observations. Accepts the native Observation shape
 * (or an array of ≤64) and the recorded launch-failure shape, whose text is matched
 * by one anchored pattern and binds only {model, min_version}: it carries no
 * executable identity, so none is guessed from the version it quotes.
 */
export function observationsFromValue(value, source) {
  const out = [];
  let rejected = 0;
  const items = Array.isArray(value) ? value.slice(0, 64) : [value];
  if (Array.isArray(value) && value.length > 64) rejected += value.length - 64;
  for (const o of items) {
    if (!o || typeof o !== "object" || Array.isArray(o) || !ISO.test(o.at ?? "")) { rejected++; continue; }
    if (typeof o.observed === "string" && o.status === "provider-version-incompatible-before-task-execution") {
      const m = LAUNCH_FAILURE.exec(o.observed);
      if (!m) { rejected++; continue; }
      out.push({ at: o.at, model: m[3], provider: "anthropic", surface: "claude-code", outcome: "rejected-version",
        min_version: m[2], executable: null, source });
      continue;
    }
    const keys = ["at", "model", "provider", "surface", "outcome", "min_version", "effort", "executable", "source"];
    const e = o.executable;
    const n = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
    const exeOk = e === undefined || e === null || (e && typeof e === "object" && typeof e.realpath === "string" &&
      path.isAbsolute(e.realpath) && !CONTROL.test(e.realpath) && n(e.dev) && n(e.ino) && n(e.size) && n(e.mtimeMs) &&
      Object.keys(e).every((k) => ["realpath", "dev", "ino", "size", "mtimeMs"].includes(k)));
    if (!Object.keys(o).every((k) => keys.includes(k)) || !isToken(o.model) || !["anthropic", "openai"].includes(o.provider) ||
      !isToken(o.surface) || !OUTCOMES.includes(o.outcome) || !exeOk ||
      (o.min_version !== undefined && !VERSION.test(o.min_version)) ||
      (o.outcome === "rejected-effort" ? !isToken(o.effort) : o.effort !== undefined)) { rejected++; continue; }
    out.push({ at: o.at, model: o.model, provider: o.provider, surface: o.surface, outcome: o.outcome,
      ...(o.min_version ? { min_version: o.min_version } : {}), ...(o.effort ? { effort: o.effort } : {}),
      executable: e ?? null, source });
  }
  return { observations: out, rejected };
}

/** A per-call operator file: regular, ≤64 KiB, JSON. Unusable input yields no observation. */
export function readObservationFile(file) {
  const source = `operator-input:${safeText(file, 200)}`;
  let fd;
  try {
    // Non-blocking open: a FIFO or device is refused by the isFile check, never waited on.
    fd = fs.openSync(path.resolve(file), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) return { observations: [], rejected: 1 };
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return observationsFromValue(JSON.parse(buf.toString("utf8")), source);
  } catch {
    return { observations: [], rejected: 1 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ── public metadata ─────────────────────────────────────────────────────────
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDate(text) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = /\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/.exec(text);
  const month = long ? MONTHS.indexOf(long[1].toLowerCase()) : -1;
  return month < 0 ? null : `${long[3]}-${String(month + 1).padStart(2, "0")}-${long[2].padStart(2, "0")}`;
}

/** Every distinct date written in `text` (ISO or "Month D, YYYY"). */
function datesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/g)) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) out.add(`${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  return [...out];
}

// Retirement dates are read only from a positively recognised assertion; anything else is unknown (both fields
// null), never a fabricated retirement. D is the date isoDate reads. D's lead is the WHOLE text from the start of
// its sentence or table cell (a "." / "!" / "?" before whitespace, or "|") to D, and must be exactly one of:
//   bare       nothing, "on" or "(" — only when D's clause opens the text or a table cell (so "Approx. D",
//              "Est. D" or "Retires approx. D" cannot make a bare date out of an abbreviation period).
//   cell       VERB or "retirement (date)", optional ":" / dash, optional PREP; a bare FLOOR; or
//              "no longer available / unavailable after".
//   subject    ["The"] ID ("," / "and" / "&" ID)* ["model(s)"] VERB ["from" surface names] [PREP], in prose
//              case; only the listed ids own D ("gpt-old", "GPT-5.5": a token with "-" or ".").
//   VERB = [will (be) | is/are/was/were (being) | has/have been] retire(s|d) / retiring / deprecated / removed /
//          discontinued / sunset;  PREP = FLOOR | "on" / "as of" / "effective";
//   FLOOR = "not/no sooner/earlier than" / "not before" / "on or after".
// Any other lead ("may/might/could retire on", "expected to retire on", "Planned:", "Possibly on", "around", "by",
// "until" …) is unknown. After D: "at (the) earliest" / "or later" makes a floor; then only the clause end (";",
// "|", sentence end), ")", or a continuation may follow: ", " / "and" / ", and" + a NOTE (below), or "for" / "with" /
// "in favo(u)r of" + a model id or a surface scope ("Codex with ChatGPT sign-in"); a floor may instead end with a
// "(see …)" note. A FLOOR lead or trail gives retire_not_before, else retire_on.
// A hedge word in D's clause makes it unknown, except an attributive "estimated / approximate / tentative
// <noun>" about something other than the date ("estimated migration effort"); so does any other bound cue after
// its trail (floor wording, "at the latest", "or earlier/sooner", "or later" not after a dotted version).
// Context is bounded (≤2000 chars on each side of D, else unknown) and read by a closed grammar only:
//   before D's clause (same cell)  every sentence must itself be a recognised claim that agrees — an unknown
//                                  prefix ("Poss.", "Unconfirmed.", "Draft proposal.") is never discarded;
//   after it (same cell)           EVERY clause (split at ";" / sentence end) must, as a whole, be an agreeing
//                                  recognised claim or one supported NOTE;
//   other cells of a table row     keep the hedge and bound-cue checks.
// NOTE (anchored; M = a gpt-/claude- id or "a model / an (available) replacement [available to your plan …]"):
//   replace  "Replace M with M (, and M with M)*"  ─┐ optional endings: "in your/saved config/settings/…",
//   migrate  "Migrate/Move your requests/… to M"    ├ "when available to your account/plan/client …"
//   update   "Update C(, [and] C)* with/to M"      ─┘ C = config noun (defaults, settings, agents, tasks …)
//   admin    "[In S( and S)*,] an administrator must enable NAME [first]"
//   see      "See [the] [T]* DOC-NOUN [for P( and P)*]"  T = id / capitalised word; P = replacements, checklist …
//   effort   "[Estimated] migration [effort] is/takes [about/approximately/around/roughly] N minutes/hours/…"
//   guide    "[Tentatively,] a/the [new/updated] [migration] guide/checklist ships/is published/is available
//            [next week/month | soon]"
// A NOTE never holds a modal, a bound cue or a calendar date; a hedge only in the effort/guide slots shown.
// Any other clause, whatever its length and with or without a hedge word, makes D unknown ("Nothing is confirmed
// yet.", "This date may change."). A deterministic parser cannot read arbitrary language, so an unrecognised
// appendage is an unsupported (unknown) result, never a confirmed date; supported notes keep D definite.
// Claims agree when both fields are equal or both name disjoint subjects; a conflict is unknown, and so is a claim
// that names its own retired subject as its replacement target ("… retired on D in favor of <the same id>"; for a
// table row's subjectless claim, any id that row binds, which makes every id it binds unknown).
const HEDGE = /\b(?:tentative(?:ly)?|estimated|approximate(?:ly)?|approx|est(?=\.)|circa|subject\s+to\s+change|TBD|TBC)\b/gi;
const ATTRIBUTIVE = /^(?:estimated|approximate|tentative)$/i;
const DATE_NOUN = new RegExp(`^(?:${MONTHS.join("|")}|dates?|days?|retire\\w*|deprecat\\w*|remov\\w*|shut\\w*|sunset\\w*|timeline|timing|schedule\\w*|end|eol|cutoff|availability)$`, "i");
const P_FLOOR = String.raw`(?:not|no)\s+(?:sooner|earlier)\s+than|not\s+before|on\s+or\s+after`;
const P_ON = String.raw`on|as\s+of|effective`;
const VERB = String.raw`(?:(?:will|shall)\s+(?:be\s+)?|(?:is|are|was|were)\s+(?:being\s+)?|(?:has|have)\s+been\s+)?(?:retire[sd]?|retiring|deprecated|removed|discontinued|sunset(?:s|ted)?)`;
const ID = String.raw`[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)+`;
const SCOPE = String.raw`(?:[A-Z][A-Za-z0-9.-]*|and|with|the|via|sign-in)`;
const CELL_LEAD = new RegExp(String.raw`^(?:(?:${VERB}|retirement(?:\s+date)?)\s*[:—–-]?\s*(?:(${P_FLOOR}|${P_ON})\s*:?\s*)?|(${P_FLOOR})\s*:?\s*|(?:no\s+longer\s+available|unavailable)\s+after\s*)\(?$`, "i");
const SUBJECT_LEAD = new RegExp(String.raw`^(?:[Tt]he\s+)?(${ID}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)${ID})*)(?:\s+models?)?\s+${VERB}(?:\s+from\s+${SCOPE}(?:,?\s+${SCOPE}){0,11})?(?:\s+(${P_FLOOR}|${P_ON}))?\s*:?\s*\(?$`);
const BARE_LEAD = /^(?:on\s*)?\(?$/i;
const FLOOR_PREP = new RegExp(`^(?:${P_FLOOR})$`, "i");
const FLOOR_TRAIL = /^\s*\)?\s*[,(]?\s*(?:at\s+(?:the\s+)?earliest|or\s+later)\b\s*\)?/i;
const TAIL = /^\s*\)?\s*(?:$|(?:,\s*(?:and\b)?|and\b|(for|with|in\s+favou?r\s+of)\b)(.*)$)/i;
const SEE_NOTE = /^\s*\(\s*see\s+[A-Za-z][A-Za-z .-]{0,60}\)\s*$/i;
const MODAL = /\b(?:may(?!\s+\d)|might|could|would|should|possibly|probably|likely|expected|planned|proposed|pending|unless)\b/i;
const BOUND_CUE = /\b(?:(?:not|no)\s+(?:sooner|earlier)\s+than|not\s+before|on\s+or\s+after|at\s+(?:the\s+)?(?:earliest|latest)|or\s+(?:later|earlier|sooner))\b/gi;
const leadStop = (text, i) => text[i] === "|" || (/[.!?]/.test(text[i]) && /\s/.test(text[i + 1] ?? ""));
const clauseStop = (text, i) => text[i] === ";" || text[i] === "|" || (/[.!?]/.test(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1])));
const CONTEXT_MAX = 2000;
const CALENDAR = new RegExp(String.raw`\d{4}-\d{2}-\d{2}|\b(?:${MONTHS.join("|")})\s+\d{1,2}\b`, "i");
// The NOTE grammar, matched against a whole clause whose first letter is lower-cased and end mark dropped.
const MODEL = String.raw`(?:[Gg][Pp][Tt]|[Cc]laude)(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)+`;
const AUDIENCE = String.raw`(?:account|plan|client|organization|workspace)`;
const AVAILABLE = String.raw`available\s+to\s+your\s+${AUDIENCE}(?:\s+(?:and|or)\s+${AUDIENCE})?`;
const REF = String.raw`(?:${MODEL}|an?\s+(?:available\s+)?(?:model|replacement)(?:\s+${AVAILABLE})?)`;
const ENDING = String.raw`(?:\s+in\s+(?:your\s+|saved\s+)?(?:config(?:uration)?s?|settings|requests|code|scripts))?(?:\s+when\s+${AVAILABLE})?`;
const LIST = (x) => String.raw`${x}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)${x}){0,11}`;
const CONFIG = String.raw`(?:(?:your|workspace|saved|managed|custom|scheduled|model)\s+){0,3}(?:defaults|settings|configurations?|config|agents|tasks|scripts|workflows|integrations)`;
const DOC = String.raw`(?:retirement|deprecations?|guide|notes|policy|documentation|docs|page|announcement|changelog|checklist)`;
const DETAIL = String.raw`(?:the\s+)?(?:(?:plan-specific|full|more|further|migration|replacement)\s+){0,2}(?:replacements|details|information|checklist|steps|instructions|options)`;
const NAME = String.raw`[A-Z][A-Za-z0-9]*`;
const NOTES = [
  String.raw`replace\s+${REF}\s+with\s+${REF}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)${REF}\s+with\s+${REF}){0,7}${ENDING}`,
  String.raw`(?:migrate|move)\s+your\s+(?:requests|traffic|workloads|usage|code|integrations?|applications?)\s+to\s+${REF}${ENDING}`,
  String.raw`update\s+${LIST(CONFIG)}\s+(?:with|to)\s+${REF}${ENDING}`,
  String.raw`(?:in\s+${LIST(NAME)}\s*,\s*)?(?:an?|your)\s+(?:administrator|admin)\s+must\s+enable\s+(?:${MODEL}|${NAME})(?:\s+first)?`,
  String.raw`see\s+(?:the\s+)?(?:(?:${MODEL}|${NAME}|migration|models?|deprecations?|retirements?)\s+){0,4}${DOC}(?:\s+for\s+${LIST(DETAIL)})?`,
].map((p) => new RegExp(`^${p}$`));
// The only NOTEs with a hedge slot: it qualifies the migration effort or the guide, never D.
const HEDGED_NOTES = [
  String.raw`(?:(?:the\s+)?estimated\s+)?migration(?:\s+effort)?\s+(?:is|takes)\s+(?:(?:about|approximately|roughly|around)\s+)?(?:\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|a\s+few|several)\s+(?:minutes?|hours?|days?|weeks?)`,
  String.raw`(?:tentatively\s*,?\s+)?(?:a|the)\s+(?:(?:new|updated)\s+)?(?:migration\s+)?(?:guide|checklist)\s+(?:ships|is\s+published|is\s+available)(?:\s+(?:next\s+(?:week|month)|soon))?`,
].map((p) => new RegExp(`^${p}$`));
const SCOPED = new RegExp(String.raw`^(?:${MODEL}|${SCOPE}(?:,?\s+${SCOPE}){0,11})$`);
const norm = (text) => plain(text).replace(/\s+/g, " ");
/** A bound cue in `part`, except "or later" right after a dotted version ("version 2.0 or later"). */
const boundCue = (part) => [...part.matchAll(BOUND_CUE)].some((c) =>
  !/^or\s+later$/i.test(c[0]) || !/\d+\.\d+\s*$/.test(part.slice(Math.max(0, c.index - 40), c.index)));
// In a whole replace / migrate / update NOTE (NOTES[0..2]) a model after "with" / "to" is the replacement slot.
const TARGET = new RegExp(String.raw`\b(?:with|to)\s+(${MODEL})`, "g");
const MODEL_ONLY = new RegExp(`^${MODEL}$`);
/**
 * When clause `u` is, as a whole, one supported NOTE (see the grammar above): the lower-cased ids in its replacement
 * slots (possibly none), each as { id, at } with `at` where that slot's id starts in `u`; else null.
 */
function neutral(u) {
  const v = u.trim().replace(/[.!?]$/, "").trim();
  const w = v.charAt(0).toLowerCase() + v.slice(1);
  if (!w || MODAL.test(w) || boundCue(w) || CALENDAR.test(w)) return null;
  if (HEDGED_NOTES.some((re) => re.test(w))) return [];
  const i = hedged(w) ? -1 : NOTES.findIndex((re) => re.test(w));
  const lead = u.length - u.trimStart().length;
  return i < 0 ? null : i > 2 ? [] : [...w.matchAll(TARGET)]
    .map((x) => ({ id: x[1].toLowerCase(), at: lead + x.index + x[0].length - x[1].length }));
}
/** t[lo, hi) split at the global separator `sep`, as split does, each piece with where it starts in t. */
const pieces = (t, lo, hi, sep) => {
  const s = t.slice(lo, hi), out = [];
  let p = 0;
  for (const m of s.matchAll(sep)) { out.push([s.slice(p, m.index), lo + p]); p = m.index + m[0].length; }
  out.push([s.slice(p), lo + p]);
  return out;
};
const agrees = (a, b) => (a.subject && b.subject && !a.subject.some((s) => b.subject.includes(s))) ||
  (a.retire_on === b.retire_on && a.retire_not_before === b.retire_not_before);
/** True when `t` (normalised) carries a hedge that is not an attributive about a non-date noun. */
function hedged(t) {
  for (const h of t.matchAll(HEDGE)) {
    const next = /^\s+([A-Za-z]+)/.exec(t.slice(h.index + h[0].length, h.index + h[0].length + 40));
    if (!ATTRIBUTIVE.test(h[0]) || !next || DATE_NOUN.test(next[1])) return true;
  }
  return false;
}
/**
 * The recognised assertion about D, the date isoDate reads in t[lo, hi) of normalised `t`, with the rest of `t` as
 * its context → { retire_on, retire_not_before, subject: ids | null }, else null.
 */
function claimAt(t, lo, hi) {
  const s = t.slice(lo, hi);
  const date = isoDate(s);
  if (!date) return null;
  // The span isoDate read: the first ISO date, else the first "Month D, YYYY".
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? /\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/.exec(s);
  const at = lo + m.index, past = at + m[0].length;
  if (at > CONTEXT_MAX || t.length - past > CONTEXT_MAX) return null;
  let from = at, to = past, cellStart = at, cellEnd = past;
  while (from > 0 && !leadStop(t, from - 1)) from--;
  while (to < t.length && !clauseStop(t, to)) to++;
  while (cellStart > 0 && t[cellStart - 1] !== "|") cellStart--;
  while (cellEnd < t.length && t[cellEnd] !== "|") cellEnd++;
  if (hedged(t.slice(from, to))) return null;
  const lead = t.slice(from, at).trim().replace(/^[-+]\s+/, ""), trail = t.slice(past, to);
  if (lead.length > 300) return null;
  let subject = null, prep = "", g;
  if ((g = SUBJECT_LEAD.exec(lead))) { subject = g[1].match(new RegExp(ID, "g")).map((s) => s.toLowerCase()); prep = g[2] ?? ""; }
  else if ((g = CELL_LEAD.exec(lead))) prep = g[1] ?? g[2] ?? "";
  else if (!BARE_LEAD.test(lead) || (from > 0 && t[from - 1] !== "|")) return null;
  const floorTrail = FLOOR_TRAIL.exec(trail);
  const floor = FLOOR_PREP.test(prep) || !!floorTrail;
  const rest = floorTrail ? trail.slice(floorTrail[0].length) : trail;
  const tail = TAIL.exec(rest);
  const more = (tail?.[2] ?? "").trim();
  const note = tail && more && !tail[1] ? neutral(more) : null;
  if (tail ? more && !(tail[1] ? SCOPED.test(more) : note) : !(floor && SEE_NOTE.test(rest))) return null;
  if (boundCue(t.slice(past + (floorTrail ? floorTrail[0].length : 0), to))) return null;
  for (const part of [t.slice(0, cellStart), t.slice(cellEnd)]) if (hedged(part) || boundCue(part)) return null;
  // targets: ids named only as a replacement ("in favor of M", a NOTE's replacement slot) in the accepted context.
  // ats: where each target's own occurrence starts in t (parallel to targets), so a quoted mention elsewhere is not it.
  const targets = [], ats = [], moreAt = past + (floorTrail ? floorTrail[0].length : 0) + rest.length - (tail?.[2] ?? "").trimStart().length;
  for (const x of note ?? []) { targets.push(x.id); ats.push(moreAt + x.at); }
  if (/^in\b/i.test(tail?.[1] ?? "") && MODEL_ONLY.test(more)) { targets.push(more.toLowerCase()); ats.push(moreAt); }
  // own: the targets this claim itself names (its tail and its following NOTEs), not those of another agreeing claim.
  const own = [...targets];
  const claim = { retire_on: floor ? null : date, retire_not_before: floor ? date : null, subject, targets, own, at: ats };
  // Before D's clause: only recognised, agreeing claims. After it: every clause must be an agreeing claim or a NOTE.
  for (const [r, p] of pieces(t, cellStart, from, /(?<=[.!?])\s+/g)) {
    const u = r.trim(), base = p + r.length - r.trimStart().length;
    if (!u) continue;
    const c = claimAt(u, 0, u.length);
    if (!c || !agrees(c, claim)) return null;
    targets.push(...c.targets);
    for (const x of c.at) ats.push(base + x);
  }
  for (const [r, p] of pieces(t, to, cellEnd, /;|(?<=[.!?])\s+/g)) {
    const u = r.trim(), base = p + r.length - r.trimStart().length;
    if (!/[A-Za-z0-9]/.test(u)) continue;
    const c = claimAt(u, 0, u.length);
    const n = c ? (agrees(c, claim) ? c.targets.map((id, i) => ({ id, at: c.at[i] })) : null) : neutral(u);
    if (!n) return null;
    for (const x of n) { targets.push(x.id); ats.push(base + x.at); }
    if (!c) own.push(...n.map((x) => x.id));
  }
  return claim;
}
const assertion = (text) => { const t = norm(text); return claimAt(t, 0, t.length); };
/**
 * The fields `id` takes from `claim`: a subject assertion binds only its listed ids; a subjectless one binds when allowed.
 * A claim whose own replacement target is its retired subject (subjectless: `id` itself) is contradictory: unknown.
 */
const selfTarget = (claim, id) => claim.own.some((x) => (claim.subject ? claim.subject.includes(x) : x === id));
const bindClaim = (claim, id, subjectless) => claim && (claim.subject ? claim.subject.includes(id) : subjectless) && !selfTarget(claim, id)
  ? { retire_on: claim.retire_on, retire_not_before: claim.retire_not_before } : { retire_on: null, retire_not_before: null };
const retirement = (text, id) => bindClaim(assertion(text), id, true);

/**
 * Markdown/MDX as structured blocks, read as text only (nothing is executed):
 *   { heading, path, rows }   a table            { heading, path, line }  a prose paragraph or list item
 *   { heading, path, card }   a literal JSX `name="…"` attribute of a component tag
 * `path` is the heading nesting (outermost first). Fenced code is example text and is
 * skipped, including `#` lines inside it; other markup lines are not prose.
 */
function sections(text) {
  const out = [];
  const stack = [];
  let heading = "", path = [];
  let table = null, para = null, fence = null, tag = false;
  const flush = () => { if (para) out.push({ heading, path, line: para.join(" ") }); para = null; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    if (f) { flush(); table = null; fence = f[1]; continue; }
    if (tag) {
      const name = /^name="([^"]*)"$/.exec(line);
      if (name) out.push({ heading, path, card: name[1] });
      if (/\/?>$/.test(line)) tag = false;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush(); table = null;
      while (stack.length && stack[stack.length - 1].level >= h[1].length) stack.pop();
      stack.push({ level: h[1].length, text: h[2] });
      heading = h[2];
      path = stack.map((s) => s.text);
      continue;
    }
    if (line.startsWith("|")) {
      flush();
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) { table = { heading, path, rows: [] }; out.push(table); }
      table.rows.push(cells);
      continue;
    }
    table = null;
    const component = /^<[A-Z][A-Za-z0-9.]*\b(.*)$/.exec(line);
    if (component) {
      flush();
      const name = /\bname="([^"]*)"/.exec(component[1]);
      if (name) out.push({ heading, path, card: name[1] });
      tag = !/\/?>$/.test(line);
      continue;
    }
    if (/^<\/?[A-Za-z!]/.test(line)) { flush(); continue; }
    if (!line) { flush(); continue; }
    if (/^(?:[-*+]|\d+\.)\s/.test(line)) flush();
    (para ??= []).push(line);
  }
  flush();
  return out;
}

// Cell text without emphasis/code marks; a markdown link `[label](url)` reads as its label.
const plain = (cell) => cell.replace(/\[([^[\]]*)\]\([^()\s]*\)/g, "$1").replace(/[*_`]/g, "").trim();

/**
 * platform.claude.com models overview (markdown). The current lineup is the table
 * whose row is labelled "Claude API ID"; each column's backticked id is one model.
 * "Legacy" headings (at any nesting level) mark legacy ids. Default effort /
 * retirement come from the same labelled rows (a linked label reads as its text); a
 * "not sooner than" retirement cell is a floor (retire_not_before), not retire_on.
 * Ambiguity (two lineup tables, an id in two lifecycles, no id) is a parse
 * rejection, never a partial catalog.
 */
export function parseAnthropicModels(text) {
  const family = (id) => /^claude-(fable|opus|sonnet|haiku)-/.exec(id)?.[1] ?? null;
  const rows = new Map();
  let lineups = 0;
  for (const block of sections(text)) {
    if (block.card !== undefined) continue;
    const legacy = block.path.some((h) => /legacy|deprecat/i.test(h));
    if (block.rows) {
      const idRow = block.rows.find((r) => /^(claude )?api (model )?(id|name)$/i.test(plain(r[0] ?? "")));
      if (!idRow) continue;
      if (!legacy) lineups++;
      const effortRow = block.rows.find((r) => /^default effort$/i.test(plain(r[0] ?? "")));
      const retireRow = block.rows.find((r) => /retire/i.test(plain(r[0] ?? "")));
      idRow.slice(1).forEach((cell, i) => {
        const id = /`(claude-[a-z0-9-]+)`/.exec(cell)?.[1] ?? /^(claude-[a-z0-9-]+)$/.exec(plain(cell))?.[1];
        if (!id) return;
        const effortCell = effortRow ? plain(effortRow[i + 1] ?? "").toLowerCase() : "";
        const default_effort = /not supported/.test(effortCell) ? "unsupported"
          : /^(low|medium|high|xhigh|max)$/.test(effortCell) ? effortCell : null;
        const row = { model: id, tier: family(id), lifecycle: legacy ? "legacy" : "current", default_effort,
          ...retirement(retireRow ? retireRow[i + 1] ?? "" : "", id), labels: [] };
        if (rows.has(id) && rows.get(id).lifecycle !== row.lifecycle) rows.set(id, null);
        else if (!rows.has(id)) rows.set(id, row);
      });
    } else if (legacy) {
      for (const m of block.line.matchAll(/`(claude-[a-z0-9-]+)`/g)) {
        const id = m[1];
        if (rows.has(id) && rows.get(id)?.lifecycle !== "legacy") rows.set(id, null);
        else if (!rows.has(id)) rows.set(id, { model: id, tier: family(id), lifecycle: "legacy", default_effort: null, retire_on: null, retire_not_before: null, labels: [] });
      }
    }
  }
  const list = [...rows.values()];
  if (lineups !== 1 || list.includes(null) || !list.some((r) => r.lifecycle === "current")) return null;
  return list;
}

/**
 * learn.chatgpt.com Codex models (markdown/MDX), scoped to ChatGPT sign-in. Lifecycle
 * comes from the nearest classifying heading in the nesting (recommended / rollout /
 * other / deprecated or retired). Ids are backticked `gpt-…` tokens in prose/tables
 * and literal component `name="gpt-…"` attributes (model cards); fenced code is an
 * example, never a claim. In a retirement/deprecation section only the retired
 * SUBJECT counts: an id introduced as its replacement ("with `x`", "choose … `x`")
 * or named only as a recognised claim's replacement target ("migrate … to `x`", "in favor of `x`")
 * is not a retired model. A retirement notice about an id listed among other models
 * refines that listing; a recommended id that is also a retired subject, an id in
 * two other lifecycles, two different dates for one id, or no recommended id rejects
 * the page.
 */
export function parseCodexModels(text) {
  const ID = /^gpt-[a-z0-9.-]+$/;
  const rows = new Map();
  const classify = (path) => {
    for (let i = path.length - 1; i >= 0; i--) {
      const h = path[i];
      const lifecycle = /deprecat|retir/i.test(h) ? "deprecated" : /recommend/i.test(h) ? "current"
        : /rollout|still available|other models/i.test(h) ? "legacy" : null;
      if (lifecycle) return lifecycle;
    }
    return null;
  };
  // Local cue only: the ≤200 characters before the id, so parsing stays linear on a large body.
  const replacementRef = (sentence, index) => {
    const before = sentence.slice(Math.max(0, index - 200), index).trimEnd();
    return !/\b(?:instead of|replace|replacing)$/i.test(before) &&
      (/\bwith(?:\s+\*\*[^*]*\*\*)?\s*\(?$/i.test(before) ||
        /\b(?:choose|select|switch to|migrate to|upgrade to|instead|replacement)\b/i.test(before));
  };
  const add = (id, lifecycle, dates) => {
    const row = { model: id, tier: null, lifecycle, default_effort: null, retire_on: null, retire_not_before: null,
      ...dates, labels: lifecycle === "current" ? ["recommended"] : [] };
    const prev = rows.get(id);
    if (prev === undefined) { rows.set(id, row); return; }
    if (prev === null) return;
    const pair = [prev.lifecycle, lifecycle].sort().join("+");
    if (prev.lifecycle !== lifecycle && pair !== "deprecated+legacy") { rows.set(id, null); return; }
    const kept = prev.lifecycle === "deprecated" ? prev : row;
    const other = kept === prev ? row : prev;
    for (const k of ["retire_on", "retire_not_before"]) {
      if (kept[k] === null) kept[k] = other[k];
      else if (other[k] !== null && other[k] !== kept[k]) { rows.set(id, null); return; }
    }
    rows.set(id, kept);
  };
  // Where each character of raw `text` lands in t = norm(text): off[r] is the length of the part of t produced by
  // text[0, r). norm only deletes characters (a link's brackets and URL, "*" "_" "`", the trimmed ends, all but the
  // first of a whitespace run), so a sentence at raw [a, b) can only be located inside t[off[a], off[b]). One pass;
  // null when the mirror of norm disagrees with t, so nothing is located (unknown, never a date).
  const normOffsets = (text, t) => {
    const keep = new Uint8Array(text.length).fill(1);
    for (const m of text.matchAll(/\[([^[\]]*)\]\([^()\s]*\)/g)) {
      keep[m.index] = 0;
      keep.fill(0, m.index + 1 + m[1].length, m.index + m[0].length);
    }
    for (let i = 0; i < text.length; i++) if (keep[i] && /[*_`]/.test(text[i])) keep[i] = 0;
    for (let i = 0; i < text.length && (!keep[i] || /\s/.test(text[i])); i++) keep[i] = 0;
    for (let i = text.length - 1; i >= 0 && (!keep[i] || /\s/.test(text[i])); i--) keep[i] = 0;
    const off = new Int32Array(text.length + 1);
    let space = false;
    for (let i = 0; i < text.length; i++) {
      if (keep[i]) { const ws = /\s/.test(text[i]); if (ws && space) keep[i] = 0; space = ws; }
      off[i + 1] = off[i] + keep[i];
    }
    return off[text.length] === t.length ? off : null;
  };
  // The quoted id whose first character is raw text[r] IS a replacement slot only when that very occurrence, kept whole
  // by norm, starts a slot of the same id (`slots`: start in t → id). An unlocated text (off null) has no slot.
  const slotAt = (off, r, id, slots) => Boolean(off) && off[r + id.length] - off[r] === id.length && slots.get(off[r]) === id;
  // A deprecation table row, dated or not, is one record of cells: its sentences are read per cell, never across "|",
  // so a quoted mention is discounted only when it is itself a replacement slot of its own cell. A cell's slots are those
  // of its recognised claim (every claim of a cell reads the whole cell), else those of its supported NOTE clauses; an
  // unquoted slot of the same id never discounts a quoted mention. The row's subjects
  // are the ids some cell names other than only as a replacement. Every claim of the row binds them; when any dated
  // sentence is unrecognised or any slot of the row names a subject, the row contradicts itself and each subject is
  // unknown, with no other claim of the row to date it. Each cell, sentence and mention is visited once, and a dated
  // sentence is looked for only in the part of t its own raw span produces (`para` is the raw row, cells joined " | ").
  const bindRow = (cells, t, para) => {
    const subjects = new Set(), slots = new Set(), claims = [];
    let cs = 0, rc = 0, off;
    for (const cell of cells) {
      let ce = t.indexOf("|", cs);
      if (ce < 0) ce = t.length;
      const sentences = cell.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/), cellClaims = [], starts = [];
      let cursor = cs, rs = 0;
      for (const sentence of sentences) {
        const a = cell.indexOf(sentence, rs);
        rs = a + sentence.length;
        starts.push(a);
        if (!isoDate(sentence)) continue;
        if (off === undefined) off = normOffsets(para, t);
        const s = norm(sentence), lo = off ? Math.max(cursor, off[rc + a]) : 0;
        const i = off ? t.slice(lo, off[rc + rs]).indexOf(s) : -1, at = i < 0 ? -1 : lo + i;
        cellClaims.push(at >= 0 && at + s.length <= ce ? claimAt(t, at, (cursor = at + s.length)) : null);
      }
      const valid = cellClaims.find(Boolean), cellSlots = new Map(), named = new Set();
      const notes = valid ? valid.targets.map((id, i) => ({ id, at: valid.at[i] })) : pieces(t, cs, ce, /;|(?<=[.!?])\s+/g)
        .flatMap(([u, p]) => /[A-Za-z0-9]/.test(u) && u.length <= CONTEXT_MAX ? (neutral(u) ?? []).map((x) => ({ id: x.id, at: p + x.at })) : []);
      for (const x of notes) { cellSlots.set(x.at, x.id); slots.add(x.id); }
      for (const c of cellClaims) for (const x of c?.subject ?? []) named.add(x);
      const ids = sentences.flatMap((sentence, k) => [...sentence.matchAll(/`(gpt-[a-z0-9.-]+)`/g)].map((m) => [sentence, m, rc + starts[k]]));
      if (cellSlots.size && off === undefined) off = normOffsets(para, t);
      for (const [sentence, m, a] of ids) {
        if (replacementRef(sentence, m.index) || (!named.has(m[1]) && slotAt(off, a + m.index + 1, m[1], cellSlots))) continue;
        subjects.add(m[1]);
      }
      claims.push(...cellClaims);
      cs = ce + 1;
      rc += cell.length + 3;
    }
    const unknown = claims.includes(null) || [...slots].some((x) => subjects.has(x));
    // The subjectless claims bind every subject alike; two different values for one field reject the page, as add does.
    const fields = { retire_on: null, retire_not_before: null };
    let conflict = false;
    for (const c of unknown ? [] : claims) if (!c.subject) for (const k of ["retire_on", "retire_not_before"]) {
      if (fields[k] === null) fields[k] = c[k];
      else if (c[k] !== null && c[k] !== fields[k]) conflict = true;
    }
    for (const id of subjects) {
      if (conflict) rows.set(id, null);
      else add(id, "deprecated", unknown ? { retire_on: null, retire_not_before: null } : fields);
    }
    for (const c of unknown ? [] : claims) for (const id of c.subject ?? []) if (subjects.has(id)) add(id, "deprecated", bindClaim(c, id, true));
  };
  for (const block of sections(text)) {
    const lifecycle = classify(block.path);
    if (!lifecycle) continue;
    if (block.card !== undefined) {
      if (ID.test(block.card)) add(block.card, lifecycle, {});
      continue;
    }
    const paragraphs = block.rows ? block.rows.map((r) => r.join(" | ")) : [block.line];
    for (const [r, para] of paragraphs.entries()) {
      // A table row's subjectless claim binds the row's whole subject set (every id the row binds, never one read as a
      // replacement): when its own target is any of them the claim contradicts itself and every id it binds is unknown,
      // as for explicit-subject prose. Ids are therefore bound once the whole row is read; one check per claim.
      const bound = [], rowSubjects = new Set(), selfRow = new Map();
      // A quoted mention is a replacement target, not a retired model, only when that very occurrence is a replacement
      // slot: of the recognised claim (located in t), else of its own sentence's supported NOTE clauses; never when the
      // claim names its id as a subject. An unquoted slot of the same id never discounts it. Each claim's slots are
      // indexed once and each lookup is constant-time, so parsing stays linear in the mentions.
      const reads = [], claimSlots = new Map();
      const bind = (sentence, claim, ids, slot) => {
        for (const m of ids) {
          if (lifecycle === "deprecated" && (replacementRef(sentence, m.index) || (!claim?.subject?.includes(m[1]) && slot(m)))) continue;
          bound.push([m[1], claim]);
          if (block.rows) rowSubjects.add(m[1]);
        }
      };
      const paraDates = lifecycle === "deprecated" ? datesIn(para) : [];
      // Claims are read in the normalised paragraph, so a sentence keeps its preceding/following context.
      const t = paraDates.length ? norm(para) : "";
      // A deprecation row without a date still separates its subjects from the replacement targets of its NOTEs.
      if (block.rows && lifecycle === "deprecated") { bindRow(block.rows[r], t || norm(para), para); continue; }
      let paraClaim, cursor = 0, rs = 0, off;
      for (const sentence of para.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/)) {
        const a = para.indexOf(sentence, rs);
        rs = a + sentence.length;
        // A subject's date: its own sentence, else the paragraph when that names exactly one date.
        let claim = null;
        if (paraDates.length && isoDate(sentence)) {
          // Located only within the part of t its own raw span produces, so an unlocated sentence costs its length.
          if (off === undefined) off = normOffsets(para, t);
          const s = norm(sentence), lo = off ? Math.max(cursor, off[a]) : 0;
          const i = off ? t.slice(lo, off[rs]).indexOf(s) : -1;
          if (i >= 0) { cursor = lo + i + s.length; claim = claimAt(t, lo + i, cursor); }
        } else if (paraDates.length === 1) claim = paraClaim === undefined ? (paraClaim = claimAt(t, 0, t.length)) : paraClaim;
        const ids = [...sentence.matchAll(/`(gpt-[a-z0-9.-]+)`/g)];
        let slot = () => false;
        if (claim && ids.length && lifecycle === "deprecated") {
          if (off === undefined) off = normOffsets(para, t);
          if (!claimSlots.has(claim)) claimSlots.set(claim, new Map(claim.at.map((x, i) => [x, claim.targets[i]])));
          const slots = claimSlots.get(claim);
          slot = (m) => slotAt(off, a + m.index + 1, m[1], slots);
        } else if (!claim && ids.length && lifecycle === "deprecated") {
          // A sentence with no claim, like a dateless row cell, still separates its ids from the replacement slots of its
          // own supported NOTE clauses (same grammar, located in the sentence); it dates nothing. A leading "-" / "+" list
          // marker is structure, stripped as claimAt strips it from a lead.
          const s = norm(sentence), so = normOffsets(sentence, s), slots = new Map();
          for (const [u, p] of pieces(s, /^[-+]\s+/.exec(s)?.[0].length ?? 0, s.length, /;|(?<=[.!?])\s+/g)) {
            if (/[A-Za-z0-9]/.test(u) && u.length <= CONTEXT_MAX) for (const x of neutral(u) ?? []) slots.set(p + x.at, x.id);
          }
          slot = (m) => slotAt(so, m.index + 1, m[1], slots);
        }
        if (block.rows) reads.push([sentence, claim, ids, slot]); else bind(sentence, claim, ids, slot);
      }
      for (const [sentence, claim, ids, slot] of reads) bind(sentence, claim, ids, slot);
      for (const [id, claim] of bound) {
        if (block.rows && claim && !claim.subject) {
          if (!selfRow.has(claim)) selfRow.set(claim, claim.own.some((x) => rowSubjects.has(x)));
          if (selfRow.get(claim)) { add(id, lifecycle, { retire_on: null, retire_not_before: null }); continue; }
        }
        // Prose binds a date only to the ids its subject names; a table row's subjectless cell binds the row.
        add(id, lifecycle, bindClaim(claim, id, Boolean(block.rows)));
      }
    }
  }
  const list = [...rows.values()];
  if (list.includes(null) || !list.some((r) => r.lifecycle === "current")) return null;
  return list;
}

export const SURFACES = Object.freeze({
  "anthropic-models": Object.freeze({ url: "https://platform.claude.com/docs/en/models/overview.md",
    hosts: Object.freeze(["platform.claude.com"]), parse: parseAnthropicModels }),
  "openai-codex-models": Object.freeze({ url: "https://learn.chatgpt.com/docs/models.md",
    hosts: Object.freeze(["learn.chatgpt.com"]), parse: parseCodexModels }),
});

export const FETCH_LIMITS = Object.freeze({ deadlineMs: 2500, maxBytes: 2 * 1024 * 1024, maxRedirects: 2 });
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];

/**
 * Env overrides may only tighten the budget: finite integers within (0, default]
 * (redirects within [0, 2]). "unlimited", NaN or a larger value refuses the whole
 * metadata step — the decision is then labelled degraded, never fresh.
 */
export function fetchBudget(env = {}) {
  const pick = (key, max, min) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return max;
    const n = Number(String(raw).trim());
    return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
  };
  const budget = {
    deadlineMs: pick("AIGENTRY_CATALOG_REVALIDATE_MS", FETCH_LIMITS.deadlineMs, 1),
    maxBytes: pick("AIGENTRY_CATALOG_MAX_BYTES", FETCH_LIMITS.maxBytes, 1),
    maxRedirects: pick("AIGENTRY_CATALOG_MAX_REDIRECTS", FETCH_LIMITS.maxRedirects, 0),
  };
  return Object.values(budget).every(Number.isFinite) ? { ok: true, budget } : { ok: false };
}

/** node:https GET, own socket (agent:false), abortable, body counted as it streams. */
export function httpsTransport(url, { signal, maxBytes, headers }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers, agent: false, signal }, (res) => {
      const status = res.statusCode ?? 0;
      const head = { location: res.headers.location, "content-type": res.headers["content-type"] };
      if (status < 200 || status >= 300) { res.destroy(); resolve({ status, headers: head, body: Buffer.alloc(0) }); return; }
      if (Number(res.headers["content-length"]) > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { kind: "too-large" }));
        return;
      }
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(); reject(Object.assign(new Error("body too large"), { kind: "too-large" })); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, headers: head, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function allowedUrl(raw, base, hosts) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !hosts.includes(u.hostname)) return null;
  u.hash = "";
  return u.href;
}

/**
 * One surface, at most one initial GET, ≤maxRedirects same-host redirects, one
 * whole-step deadline. After the deadline every socket is aborted and no result
 * is parsed. The result never throws: fresh | http-<code> | timeout | offline |
 * parse-rejected | body-too-large | redirect-rejected | proxy-unsupported |
 * budget-invalid | disabled | surface-unavailable.
 */
export async function fetchSurface(id, { transport = httpsTransport, now = () => new Date(), env = {} } = {}) {
  // Own keys only: constructor/toString/__proto__ are not surfaces and never reach the transport.
  const spec = typeof id === "string" && Object.hasOwn(SURFACES, id) ? SURFACES[id] : undefined;
  const result = (r, extra = {}) => ({ id, url: spec?.url ?? null, final_url: null, result: r,
    fetched_at: now().toISOString(), body_sha256: null, bytes: 0, redirects: 0, rows: null, ...extra });
  if (!spec) return result("surface-unavailable");
  if (env.AIGENTRY_MODEL_METADATA === "off") return result("disabled");
  if (env.AIGENTRY_MODEL_METADATA !== undefined && env.AIGENTRY_MODEL_METADATA !== "") return result("budget-invalid");
  const b = fetchBudget(env);
  if (!b.ok) return result("budget-invalid");
  const { deadlineMs, maxBytes, maxRedirects } = b.budget;
  if (transport === httpsTransport && PROXY_KEYS.some((k) => env[k])) return result("proxy-unsupported");
  const controller = new AbortController();
  const headers = { accept: "text/markdown, text/plain;q=0.9", "user-agent": "aigentry-orchestrator-model-evidence/1" };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(result("timeout")); }, deadlineMs);
  });
  const walk = async () => {
    let url = allowedUrl(spec.url, undefined, spec.hosts);
    try {
      for (let redirects = 0; ; redirects++) {
        const res = await transport(url, { signal: controller.signal, maxBytes, headers });
        if (controller.signal.aborted) return result("timeout");
        if (res.status >= 300 && res.status < 400) {
          const next = res.headers?.location ? allowedUrl(res.headers.location, url, spec.hosts) : null;
          if (!next || redirects >= maxRedirects) return result("redirect-rejected", { final_url: url, redirects });
          url = next;
          continue;
        }
        if (res.status !== 200) return result(`http-${res.status}`, { final_url: url, redirects });
        const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ""));
        if (body.length > maxBytes) return result("body-too-large", { final_url: url, redirects });
        const sha = createHash("sha256").update(body).digest("hex");
        const type = String(res.headers?.["content-type"] ?? "");
        const rows = /^text\/(markdown|plain)\b/i.test(type) ? spec.parse(body.toString("utf8")) : null;
        return result(rows ? "fresh" : "parse-rejected", { final_url: url, redirects, body_sha256: sha, bytes: body.length, rows });
      }
    } catch (e) {
      if (controller.signal.aborted) return result("timeout");
      return result(e?.kind === "too-large" ? "body-too-large" : "offline", { final_url: url });
    }
  };
  try {
    return await Promise.race([walk(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ── the --resolve command ───────────────────────────────────────────────────
function parseResolveArgs(argv) {
  const a = { observe: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (v === undefined) return null;
    if (k === "--observe") { if (a.observe.length >= 4) return null; a.observe.push(v); }
    else if (["--cli", "--sid", "--task", "--role", "--route-json"].includes(k) && a[k.slice(2)] === undefined) a[k.slice(2)] = v;
    else return null;
  }
  return a;
}

/**
 * argv: --cli claude|codex --sid S --task T [--role R] [--route-json {model,decided_by}] [--observe F]…
 * env:  PATH, AIGENTRY_<CLI>_{MODEL (explicit path only), EFFORT, EXECUTABLE, EXECUTABLE_VERSION},
 *       AIGENTRY_MODEL_METADATA=off, AIGENTRY_CATALOG_{REVALIDATE_MS,MAX_BYTES,MAX_REDIRECTS}.
 * deps: { transport, now, catalogPath } — test seams.
 * → { code: 0|2|4|10, out: one JSON line }
 */
export async function resolveCommand(argv, env = process.env, deps = {}) {
  const line = (v) => JSON.stringify(v) + "\n";
  const refusal = (code, exit, reason) => ({ code: exit, out: line({ refusal: { code, reason: safeText(reason, 600) } }) });
  const a = parseResolveArgs(argv);
  if (!a || !["claude", "codex"].includes(a.cli) || !IDENTITY.test(a.sid ?? "") || !/^[\x21-\x7e]{1,128}$/.test(a.task ?? "")) {
    return refusal("MODEL_RESOLVE_USAGE", 2, "usage: --resolve --cli claude|codex --sid S --task T [--route-json J] [--observe F]");
  }
  let route = null;
  if (a["route-json"] !== undefined) {
    try { route = JSON.parse(a["route-json"]); } catch { route = null; }
    if (!route || !isToken(route.model) || !/^(llm|table)(-capped)?$/.test(route.decided_by ?? "")) {
      return refusal("MODEL_RESOLVE_USAGE", 2, "invalid --route-json");
    }
    route = { model: route.model, decided_by: route.decided_by };
  }
  let catalog;
  try { catalog = loadCatalog(deps.catalogPath); } catch (e) { return refusal("MODEL_CATALOG_INVALID", 10, String(e?.message ?? e)); }
  const now = deps.now ?? (() => new Date());
  const upper = a.cli.toUpperCase();
  const request = {};
  const envValue = (key) => (env[key] === undefined || env[key] === "" ? undefined : env[key]);
  if (!route && envValue(`AIGENTRY_${upper}_MODEL`) !== undefined) request.model = { value: env[`AIGENTRY_${upper}_MODEL`], source: "env" };
  if (envValue(`AIGENTRY_${upper}_EFFORT`) !== undefined) request.effort = { value: env[`AIGENTRY_${upper}_EFFORT`], source: "env" };
  const declaredPath = envValue(`AIGENTRY_${upper}_EXECUTABLE`);
  if (declaredPath !== undefined) request.executable = { path: declaredPath, source: "env" };
  const collected = collectExecutables(a.cli, { pathValue: env.PATH ?? "", declaredPath,
    declaredVersion: envValue(`AIGENTRY_${upper}_EXECUTABLE_VERSION`) });
  if (collected.error) return refusal("MODEL_TUPLE_INCOMPATIBLE", 4, `${a.cli}: ${collected.error}`);
  const observations = [];
  const notes = [...collected.notes];
  for (const file of a.observe) {
    const r = readObservationFile(file);
    observations.push(...r.observations);
    if (r.rejected) notes.push(`${r.rejected} observation(s) in ${safeText(file, 120)} rejected as malformed or unsupported`);
  }
  const surface = await fetchSurface(catalog.cli[a.cli].surface, { transport: deps.transport, now, env });
  const r = resolveSpawnDecision({
    cli: a.cli, sid: a.sid, task: a.task, today: now().toISOString().slice(0, 10), route, explicitCli: !route,
    request, catalog, surface, executables: collected.executables, executableNotes: notes, observations,
  });
  if (!r.ok) return refusal(r.code, r.exit, r.reason);
  return { code: 0, out: line({ decision: r.decision }) };
}
