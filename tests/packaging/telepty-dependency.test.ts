// #1293 — the orchestrator package must not install a telepty, at any version.
//
// WHY THIS IS A PACKAGING TEST AND NOT A LINT. Nothing under src/ or bin/ imports or resolves
// @dmsdc-ai/aigentry-telepty: every call site runs the `telepty` found on PATH. A nested copy
// is therefore never EXECUTED — but its postinstall runs on the HOST at install time, and
// telepty's postinstall stops a running daemon whose version differs from its own in BOTH
// directions. Measured on 2026-11-21: installing the published orchestrator 0.2.7, which
// declared `"@dmsdc-ai/aigentry-telepty": "^0.8.0"`, pulled a nested telepty 0.8.5 whose
// postinstall stopped a supervised 0.11.2 daemon (pid 345424) and started 0.8.5 (pid 352821);
// every tracked inject then failed with TRACKING_PERSISTENCE_FAILED until the operator
// reinstalled 0.11.2 by hand. The postinstall of an already published telepty cannot be
// changed, so the only fix available to THIS package is to stop pulling telepty in.
//
// So this suite measures the two manifests, which are the only place the dependency can come
// back from:
//   1. package.json — no telepty in ANY dependency section, under any key, including an
//      `npm:` alias and including the sections with auto-install semantics that are easy to
//      believe are inert (optionalDependencies and peerDependencies are both installed by
//      npm 7+ by default; a bundled or overridden entry is installed too).
//   2. package-lock.json — no nested telepty subtree, and no lockfile dependency map that
//      names it; and npm-shrinkwrap.json, the lockfile npm PUBLISHES, under the same rule if one
//      is ever added (r2, review F7).
// and, because a future maintainer may have a real reason to depend on telepty again, it
// measures the GUARD that would then apply: a declared range that can resolve below the
// floor this orchestrator needs is refused by name. The floor is 0.11.1 — the first
// published telepty declaring `inject-bound-v1`, which src/dispatch/cli.ts requires for
// bound delivery to a busy worker (CHANGELOG 0.2.6 "Requirements").
//
// Node built-ins and file reads only: no npm, no install, no network, no registry query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const TELEPTY_PACKAGE = "@dmsdc-ai/aigentry-telepty";
/** The floor, as a version, because a range has to be compared against something. */
export const TELEPTY_MIN_VERSION = "0.11.1";
/**
 * Every package.json section npm will install from, plus the two spellings of the bundling
 * list. peerDependencies is here on purpose: npm 7+ installs peers automatically, so
 * "it is only a peer" is not a reason a nested copy would not appear.
 */
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies",
  "peerDependencies", "bundleDependencies", "bundledDependencies"] as const;

type Triple = readonly [number, number, number];
const read = (relative: string): string => readFileSync(join(REPO, relative), "utf8");
const parse = <T>(relative: string): T => JSON.parse(read(relative)) as T;

/**
 * The LOWEST version a spec can resolve to, or null when no floor can be proven from the
 * spec alone. Deliberately conservative: anything this function does not fully understand
 * (a union, an upper-bound-only comparator, a hyphen range, an x-range, `*`, a tag, a git or
 * file spec, an `npm:` alias) answers null, and null never satisfies the floor. A guard that
 * guessed in the other direction is how `^0.8.0` survived three releases.
 *
 * r1 (review R9): a PRERELEASE or build suffix is refused rather than read as its release.
 * `0.11.1-rc.1` sorts BELOW `0.11.1` in semver, so treating it as the floor would have admitted a
 * candidate that does not carry the released `inject-bound-v1`. Any `-`/`+` suffix now fails the
 * match and answers null, which this guard already treats as "cannot be proven safe".
 */
export function lowestResolvable(spec: string): Triple | null {
  const value = spec.trim();
  if (value === "" || /\|\||\s-\s|[<*]/.test(value)) return null;
  const match = /^(?:v|=|>=|>|\^|~)?v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function below(version: Triple, floor: Triple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! !== floor[i]!) return version[i]! < floor[i]!;
  }
  return false;
}

const FLOOR = lowestResolvable(TELEPTY_MIN_VERSION)!;

/**
 * Every way a manifest names telepty: as a section key, or as an `npm:` alias in a spec
 * under any other key. Returns one problem line per violation, naming the section, the key
 * and the spec, or [] when the manifest cannot install telepty at all.
 */
export function teleptyViolations(pkg: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const consider = (section: string, name: string, spec: string): void => {
    const aliased = spec.includes(TELEPTY_PACKAGE);
    if (name !== TELEPTY_PACKAGE && !aliased) return;
    const lowest = lowestResolvable(aliased ? spec.replace(/^npm:.*@/, "") : spec);
    if (lowest === null) {
      problems.push(`${section}.${name} = ${JSON.stringify(spec)} proves no lower bound, so it can ` +
        `resolve a telepty below ${TELEPTY_MIN_VERSION} (and any resolution installs telepty's postinstall)`);
      return;
    }
    if (below(lowest, FLOOR)) {
      problems.push(`${section}.${name} = ${JSON.stringify(spec)} can resolve ` +
        `${lowest.join(".")}, below the required ${TELEPTY_MIN_VERSION}`);
    }
  };
  for (const section of DEPENDENCY_SECTIONS) {
    const value = pkg[section];
    if (Array.isArray(value)) {
      for (const name of value) if (name === TELEPTY_PACKAGE) problems.push(`${section}[] bundles ${name}`);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      consider(section, name, typeof spec === "string" ? spec : JSON.stringify(spec));
    }
  }
  return problems;
}

test("1293: package.json declares no telepty in any installable section, under any key or alias", () => {
  const pkg = parse<Record<string, unknown>>("package.json");
  assert.deepEqual(teleptyViolations(pkg), [],
    "the orchestrator runs the telepty on PATH; a declared telepty is a nested copy nothing executes " +
    "whose postinstall still replaces the host daemon");
  // The sweep the enumerated sections cannot do: `overrides`, `resolutions`, a section added to
  // npm after this file was written, or a comment. The package name must not appear at all.
  assert.ok(!read("package.json").includes(TELEPTY_PACKAGE),
    `package.json still mentions ${TELEPTY_PACKAGE}; no section, override or resolution may name it`);
});

test("1293: the guard refuses every range that can resolve a telepty below the floor", () => {
  const manifest = (section: string, name: string, spec: string): Record<string, unknown> =>
    ({ [section]: { [name]: spec } });
  // Each of these is a real spelling a maintainer could write. None may pass.
  const refused = ["^0.8.0", "~0.8.0", ">=0.8.0", ">0.8.0", "0.8.5", "0.11.0", "^0.11.0", "~0.11.0",
    "*", "x", "latest", "", ">=0.8.0 <0.12.0", "0.8.0 || 0.11.1", "0.10.1 - 0.11.2",
    "github:dmsdc-ai/aigentry-telepty", "file:../aigentry-telepty",
    // r1 (review R9): a prerelease of the floor sorts BELOW the floor and must not pass as it.
    "0.11.1-rc.1", "^0.11.1-rc.1", ">=0.11.1-rc.1", "0.11.1+build.5"];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const spec of refused) {
      assert.equal(teleptyViolations(manifest(section, TELEPTY_PACKAGE, spec)).length, 1,
        `${section}: ${JSON.stringify(spec)} must be refused`);
      // The same spec reached through an `npm:` alias under an innocent key.
      assert.equal(teleptyViolations(manifest(section, "telepty", `npm:${TELEPTY_PACKAGE}@${spec}`)).length, 1,
        `${section}: alias npm:${TELEPTY_PACKAGE}@${JSON.stringify(spec)} must be refused`);
    }
    // Only a range whose own lower bound is at or above the floor is accepted.
    for (const spec of ["0.11.1", "^0.11.1", "~0.11.1", ">=0.11.1", "^0.12.0", "0.12.3", "1.0.0", "^1.2.3"]) {
      assert.deepEqual(teleptyViolations(manifest(section, TELEPTY_PACKAGE, spec)), [],
        `${section}: ${JSON.stringify(spec)} is at or above the floor and must be accepted`);
    }
  }
  assert.equal(teleptyViolations({ bundleDependencies: [TELEPTY_PACKAGE] }).length, 1, "a bundled telepty is refused");
  assert.equal(teleptyViolations({ bundledDependencies: [TELEPTY_PACKAGE] }).length, 1, "the other bundling spelling too");
  assert.deepEqual(teleptyViolations({ dependencies: { "cross-spawn": "7.0.6" } }), [], "an unrelated dependency is untouched");
});

test("1293: package-lock.json holds no nested telepty subtree and no lockfile edge to it", () => {
  const lock = parse<{ packages?: Record<string, Record<string, unknown>> }>("package-lock.json");
  const packages = lock.packages ?? {};
  const keys = Object.keys(packages).filter((key) => key.includes("aigentry-telepty"));
  assert.deepEqual(keys, [],
    "the lockfile still installs a nested telepty; it would run telepty's postinstall on the host " +
    "and that postinstall stops a daemon whose version differs from its own, newer or older");
  const edges: string[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    for (const section of DEPENDENCY_SECTIONS) {
      const value = entry[section];
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      for (const name of Object.keys(value as Record<string, unknown>)) {
        if (name === TELEPTY_PACKAGE) edges.push(`${key || "<root>"}.${section}.${name}`);
      }
    }
  }
  assert.deepEqual(edges, [], "a lockfile dependency edge still requires telepty");
  assert.ok(!read("package-lock.json").includes(TELEPTY_PACKAGE),
    `package-lock.json still mentions ${TELEPTY_PACKAGE} (a resolved url or an integrity line is enough ` +
    "for `npm ci` to install it)");
  // r4 (review R4-8): and by parsed identity — an escaped name, an alias spec or a mirror url.
  assert.deepEqual(lockfileTeleptyProblems(read("package-lock.json")), [],
    "package-lock.json installs a telepty under another name or from another url");
});

/**
 * Every way a lockfile-shaped document (package-lock.json, npm-shrinkwrap.json) can install telepty:
 * a package path naming it, a dependency edge to it from any entry, or the package name anywhere in
 * its text (a resolved url or an integrity line). Returns one problem line per violation.
 */
export function lockfileTeleptyProblems(text: string): string[] {
  const lock = JSON.parse(text) as { packages?: Record<string, Record<string, unknown>> };
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.includes("aigentry-telepty")) problems.push(`${key} is a telepty package entry`);
    // r4 (review R4-8): the PARSED identity — a JSON-escaped name, an alias spec or a mirror url the
    // raw-text check below cannot see.
    if (entry.name === TELEPTY_PACKAGE) problems.push(`${key || "<root>"} is named ${TELEPTY_PACKAGE}`);
    const resolved = entry.resolved;
    if (typeof resolved === "string" && resolved.includes("aigentry-telepty"))
      problems.push(`${key || "<root>"} resolves from a telepty url`);
    for (const section of DEPENDENCY_SECTIONS) {
      const value = entry[section];
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
        if (name === TELEPTY_PACKAGE) problems.push(`${key || "<root>"}.${section}.${name} is an edge to telepty`);
        else if (typeof spec === "string" && spec.includes(TELEPTY_PACKAGE))
          problems.push(`${key || "<root>"}.${section}.${name} is an alias of telepty`);
      }
    }
  }
  if (problems.length === 0 && text.includes(TELEPTY_PACKAGE)) problems.push(`the text mentions ${TELEPTY_PACKAGE}`);
  return problems;
}

test("1293 r2: a publishable npm-shrinkwrap.json can carry no telepty either", () => {
  // review F7. npm publishes a root npm-shrinkwrap.json whatever `files` says, and a consumer's
  // install obeys it — so it is a second authoritative resolution input beside the manifest, which
  // could pin a transitive optional or peer edge to an old telepty while package-lock.json stays
  // clean. This repository has none today; if one is ever added, it must pass the lockfile rule.
  if (existsSync(join(REPO, "npm-shrinkwrap.json"))) {
    assert.deepEqual(lockfileTeleptyProblems(read("npm-shrinkwrap.json")), [],
      "npm-shrinkwrap.json would install a telepty with this package");
  }
  // r3 (review R3-7): this package needs no shrinkwrap, and a parsed-identity check of every alias,
  // escape and install marker a shrinkwrap can carry is more than one guard can promise. So a root
  // npm-shrinkwrap.json is refused outright; a maintainer who needs one must come past this line.
  assert.equal(existsSync(join(REPO, "npm-shrinkwrap.json")), false,
    "a root npm-shrinkwrap.json would be published and obeyed by every install of this package");
  // The rule is not vacuous: a shrinkwrap pinning telepty under an otherwise permitted package, by
  // package path, by edge, or only by its resolved url, is refused each way.
  const nested = JSON.stringify({ packages: { "": { dependencies: { "cross-spawn": "7.0.6" } },
    "node_modules/cross-spawn": { optionalDependencies: { [TELEPTY_PACKAGE]: "^0.8.0" } },
    [`node_modules/${TELEPTY_PACKAGE}`]: { version: "0.8.5", hasInstallScript: true } } });
  assert.equal(lockfileTeleptyProblems(nested).length, 2, "a nested telepty entry and its optional edge must both be refused");
  const urlOnly = JSON.stringify({ packages: { "node_modules/x": {
    resolved: `https://registry.npmjs.org/${TELEPTY_PACKAGE}/-/aigentry-telepty-0.8.5.tgz` } } });
  assert.equal(lockfileTeleptyProblems(urlOnly).length, 1, "a telepty url alone must be refused");
  assert.deepEqual(lockfileTeleptyProblems(JSON.stringify({ packages: { "node_modules/cross-spawn": {} } })), [],
    "a clean shrinkwrap passes");
  // r4 (review R4-8): an alias entry whose name is JSON-escaped and whose url is a mirror's carries no
  // raw telepty name, and is refused by its parsed identity. FAILS on r3 (no problem found).
  const escaped = JSON.stringify({ packages: { "": { dependencies: { tp: "npm:x@1" } },
    "node_modules/tp": { name: "@dmsdc-ai/aigentry-telepty", version: "0.8.5",
      resolved: "https://mirror.example/tp/-/aigentry-telepty-0.8.5.tgz" } } }).replace(/@dmsdc-ai/g, "\\u0040dmsdc-ai");
  assert.ok(!escaped.includes(TELEPTY_PACKAGE), "the fixture must hide the raw name");
  assert.equal(lockfileTeleptyProblems(escaped).length, 2, "an escaped name and a mirror url must both be refused");
});

test("1293 r1: no PRODUCTION dependency in the lockfile runs an install script at all", () => {
  // review R9 — the suite above is specific to telepty by name, so a differently named production
  // package carrying a lifecycle script would escape it. The INVARIANT this incident actually
  // establishes is broader and is measurable straight from the lockfile: a `npm i -g` of this
  // package must not run anybody's postinstall on the host. npm records exactly that as
  // `hasInstallScript` per entry, and `dev: true` marks the entries a production install never
  // fetches (devDependencies are not installed by `npm i -g` or `npm ci --omit=dev`).
  //
  // This is a measurement, not an aspiration: after the regeneration the production tree carries
  // ZERO such entries — telepty itself and `node-pty`, reachable only through telepty, were the
  // only two — and the single remaining marker anywhere is the optional, dev-only `fsevents`.
  // A maintainer who genuinely needs a production install script has to come past this line and
  // say so, which is the whole point.
  const lock = parse<{ packages?: Record<string, { hasInstallScript?: unknown; dev?: unknown; optional?: unknown }> }>("package-lock.json");
  const production = Object.entries(lock.packages ?? {})
    .filter(([, entry]) => entry.hasInstallScript === true && entry.dev !== true)
    .map(([key]) => key || "<root>");
  assert.deepEqual(production, [],
    "a production dependency declares an install script; installing this package would run it on " +
    "the host, which is exactly how a nested telepty 0.8.5 replaced a running 0.11.2 daemon");
});

test("1293 r5: the published upgrade instructions are non-destructive — two installs, then read-only reads, and no prescribed fix", () => {
  // review R4-1, then R5-1 (MAJOR) / R5-4. Three rounds of instructions each told the operator to
  // CHANGE something (prune a nested tree, run telepty's service installer, unset or repoint a
  // variable) whose safety depends on host facts no document can establish; a site wrapper or a
  // service still pointing into the old directory then broke. r5's instructions change nothing beyond
  // the two npm installs: (1) the latest telepty globally, (2) the orchestrator, (3) read-only reads,
  // each bounded by what it does not show, and (4) one "if they disagree" paragraph that names the
  // possible causes and prescribes no command. Driven by README.md, its template and the CHANGELOG
  // 0.2.8 upgrade section. This FAILS on r4, whose sections run `telepty-install`, tell the operator to
  // unset TELEPTY and query schtasks, and say step 2 repairs a service.
  const between = (text: string, start: string, end: string): string => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `missing section ${start}`);
    const to = text.indexOf(end, from + start.length);
    assert.ok(to > from, `section ${start} has no end marker ${end}`);
    return text.slice(from, to);
  };
  const docs: readonly (readonly [string, string, string])[] = [
    ["README.md", between(read("README.md"), "**Upgrading from 0.2.5-0.2.7?**", "\nA new install:"),
      "npm i -g @dmsdc-ai/aigentry-orchestrator"],
    ["README.tmpl.md", between(read("README.tmpl.md"), "**Upgrading from 0.2.5-0.2.7?**", "\nA new install:"),
      "npm i -g {{name}}"],
    ["CHANGELOG.md 0.2.8", between(read("CHANGELOG.md"), "### Upgrading from 0.2.5-0.2.7\n", "\n### "),
      "npm i -g @dmsdc-ai/aigentry-orchestrator"],
  ];
  // Every instruction class the three rejected rounds used to change host state beyond the two installs.
  const DESTRUCTIVE: readonly (readonly [string, RegExp])[] = [
    ["prune", /\bprun(e|ed|es|ing)\b/i],
    ["uninstall", /uninstall/i],
    ["rm", /\brm\b/],
    ["delete", /\bdelet(e|ed|es|ing)\b/i],
    ["telepty-install", /telepty-install/],
    ["unset", /\bunset\b/i],
    ["launchctl", /launchctl/i],
    ["systemctl", /systemctl/i],
    ["schtasks", /schtasks/i],
    ["a step that repairs a service", /repair/i],
  ];
  for (const [label, raw, upgrade] of docs) {
    const text = raw.replace(/\s+/g, " ");
    for (const [name, pattern] of DESTRUCTIVE)
      assert.doesNotMatch(text, pattern, `${label}: the upgrade section still carries a '${name}' instruction`);
    // r4's guards against the r3 check-driven sequence stay (review R4-1/R4-9).
    for (const detection of ["grep -rl", "If a check fail"])
      assert.ok(!text.includes(detection), `${label}: the unreliable check '${detection}' is still offered`);
    // The two installs, in order, then every read-only read AFTER both of them.
    const telepty = text.indexOf("npm i -g @dmsdc-ai/aigentry-telepty@latest");
    const orchestrator = text.indexOf(upgrade);
    assert.ok(telepty >= 0 && orchestrator > telepty, `${label}: telepty must be installed before the orchestrator is upgraded`);
    assert.equal(text.split("npm i -g ").length - 1, 2, `${label}: the upgrade section must run exactly the two installs`);
    for (const probe of ["command -v telepty", "where telepty", "telepty --version", "/api/meta"]) {
      // r6 (R6-1): `command -v telepty` and `where telepty` now also appear, as the pre-upgrade read, before
      // the upgrade; the read-only checks must still all come after it.
      const at = text.indexOf(probe, orchestrator);
      assert.ok(at > orchestrator, `${label}: the read '${probe}' is missing or precedes the two installs`);
    }
    assert.ok(text.includes("telepty 0.11.3 or newer never replaces a newer running daemon, and does nothing when it is installed as a dependency"),
      `${label}: step 1 does not say why it is safe`);
    assert.ok(text.includes("These reads change nothing"), `${label}: the reads are not stated to be read-only`);
    assert.equal(text.slice(orchestrator).split("It does not show").length - 1, 3, `${label}: each of the three reads must say what it does not show`);
    // (4) one paragraph: the possible causes are named, and no command is prescribed for any of them.
    const disagree = raw.split(/\n[ \t]*\n/).filter((p) => p.includes("If they disagree"));
    assert.equal(disagree.length, 1, `${label}: there must be exactly one "If they disagree" paragraph`);
    const paragraph = disagree[0].replace(/\s+/g, " ");
    assert.ok(text.indexOf("If they disagree") > text.indexOf("/api/meta"), `${label}: "If they disagree" precedes the reads`);
    for (const cause of ["wrapper", "symlink", "`TELEPTY` variable", "service definition written by an older install", "telepty's own documentation"])
      assert.ok(paragraph.includes(cause), `${label}: "If they disagree" does not name '${cause}'`);
    assert.deepEqual(paragraph.match(/`[^`]*`/g), ["`TELEPTY`"], `${label}: "If they disagree" prescribes a command`);
    assert.ok(!/```/.test(paragraph), `${label}: "If they disagree" carries a code block`);
  }
  // The 0.2.8 entry shows no orchestrator install command before its upgrade steps (review R4-1).
  const entry = between(read("CHANGELOG.md"), "## [0.2.8]", "\n## [");
  assert.ok(entry.indexOf("npm i -g @dmsdc-ai/aigentry-orchestrator") > entry.indexOf("### Upgrading from 0.2.5-0.2.7"),
    "CHANGELOG 0.2.8 shows the orchestrator install command before the upgrade steps");
});

test("1293 r6: the upgrade states what it removes BEFORE the upgrade step, and the section carries only the two installs and the read-only reads", () => {
  // review R6-1 (MAJOR) / R6-2 / R6-4. 0.2.8 no longer depends on telepty, so upgrading removes the copy
  // that 0.2.5-0.2.7 nested inside this package; a wrapper, symlink, TELEPTY variable or service still
  // running that copy stops working. r5 said so nowhere and only read the host AFTER the upgrade. The
  // fact and its consequence must now stand before the orchestrator upgrade command, with one read-only
  // read and what it does not show, and no command that changes anything. Instead of banning words, the
  // section's commands are an ALLOWLIST: every inline code span, every fenced block and every line that
  // looks like a command must be one of the two installs, a reviewed read, or a plain name. Driven by
  // README.md, its template and the CHANGELOG 0.2.8 upgrade section. This FAILS on r5: none of its three
  // files has a "Before you upgrade" step, and each offers `where.exe telepty`.
  const between = (text: string, start: string, end: string): string => {
    const from = text.indexOf(start);
    assert.ok(from >= 0, `missing section ${start}`);
    const to = text.indexOf(end, from + start.length);
    assert.ok(to > from, `section ${start} has no end marker ${end}`);
    return text.slice(from, to);
  };
  const ORCH = "@dmsdc-ai/aigentry-orchestrator";
  const docs: readonly (readonly [string, string, string])[] = [
    ["README.md", between(read("README.md"), "**Upgrading from 0.2.5-0.2.7?**", "\nA new install:"), ORCH],
    ["README.tmpl.md", between(read("README.tmpl.md"), "**Upgrading from 0.2.5-0.2.7?**", "\nA new install:"), "{{name}}"],
    ["CHANGELOG.md 0.2.8", between(read("CHANGELOG.md"), "### Upgrading from 0.2.5-0.2.7\n", "\n### "), ORCH],
  ];
  for (const [label, raw, pkg] of docs) {
    const INSTALLS = ["npm i -g @dmsdc-ai/aigentry-telepty@latest", `npm i -g ${pkg}`];
    const READS = ["command -v telepty", "Get-Command telepty", "where telepty", "telepty --version", "npm root -g"];
    const NAMES = ["TELEPTY", "TELEPTY_PORT", "version", "python3", "curl", "telepty", pkg];
    const META_READ = `( cd "$(npm root -g)/${pkg}" && . bin/lib/telepty-auth.sh && ` +
      `curl -s --noproxy '*' --max-time 5 -H "x-telepty-token: $(telepty_auth_token)" \\ ` +
      `"http://127.0.0.1:\${TELEPTY_PORT:-3848}/api/meta" )`;
    const text = raw.replace(/\s+/g, " ");

    // (a) The pre-upgrade step: after the telepty install, before the orchestrator upgrade, naming the consequence.
    const telepty = text.indexOf(INSTALLS[0]);
    const orchestrator = text.indexOf(INSTALLS[1]);
    const before = text.indexOf("Before you upgrade");
    assert.ok(telepty >= 0 && before > telepty && orchestrator > before,
      `${label}: the paragraph on what the upgrade removes must stand between the telepty install and the orchestrator upgrade`);
    const step = text.slice(before, orchestrator);
    for (const fact of [
      "This release no longer contains a telepty",
      "upgrading removes the copy of telepty that earlier versions carried inside this package's directory",
      "a shell wrapper", "a symlink", "a `TELEPTY` variable",
      "a service definition whose program path lies inside this package's directory",
      "stops working after the upgrade, until it is pointed at the telepty installed in step 1",
      "It is not downgraded",
      "it changes nothing: `command -v telepty` shows the file your shell runs",
      "`where telepty` lists the files named telepty that it finds, and does not establish which one cmd runs",
      "it does not show what a service runs",
      "If you cannot tell whether anything on this host still runs that copy, upgrade at a time when a short telepty interruption is acceptable",
    ])
      assert.ok(step.includes(fact), `${label}: the pre-upgrade step does not state '${fact}'`);
    assert.doesNotMatch(step, /cannot be affected|not affected|unaffected|is safe|are safe/i,
      `${label}: the pre-upgrade step claims a host is safe from the removal`);
    for (const span of step.match(/`[^`]*`/g) ?? [])
      assert.ok([...READS, ...NAMES].includes(span.slice(1, -1)), `${label}: the pre-upgrade step carries ${span}, which is not a read-only read`);

    // (b) The allowlist: every command in the section is one of the two installs or a reviewed read.
    const fences = raw.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
    assert.equal(fences.length, 1, `${label}: the only fenced block allowed is the daemon meta read`);
    assert.equal(fences[0].replace(/^```[^\n]*\n/, "").replace(/```$/, "").replace(/\s+/g, " ").trim(), META_READ,
      `${label}: the fenced block is not exactly the reviewed daemon meta read`);
    const prose = raw.replace(/```[^\n]*\n[\s\S]*?```/g, "");
    // The CHANGELOG section ends with r5's paragraph on what init checks after the upgrade; it names init and
    // the document it reads, and is the one place those three spans are allowed.
    const INIT_NOTE = "After the upgrade, `aigentry-orchestrator init`";
    for (const paragraph of prose.split(/\n[ \t]*\n/)) {
      const described = paragraph.startsWith(INIT_NOTE) ? ["aigentry-orchestrator init", "--dry-run", "telepty boot-capabilities"] : [];
      for (const span of paragraph.match(/`[^`]*`/g) ?? [])
        assert.ok([...INSTALLS, ...READS, ...NAMES, ...described].includes(span.slice(1, -1).replace(/\s+/g, " ")),
          `${label}: ${span} is not one of the two installs, a reviewed read or a plain name`);
    }
    assert.doesNotMatch(prose, /<\s*(code|pre|kbd|samp)\b/i, `${label}: the section carries an HTML code element`);
    for (const line of prose.replace(/`[^`]*`/g, "``").split("\n")) {
      const body = line.replace(/^\s*(?:[-*+]|\d+\.)?\s*/, "");
      assert.doesNotMatch(body, /^(?:[$#>]\s+\S|PS\s*[A-Za-z]:\\|PS>|[A-Za-z]:\\[^\s>]*>)/,
        `${label}: a prompt-style command line outside the reviewed commands: ${line}`);
      assert.doesNotMatch(body, /\s&&\s|\s\|\|?\s|\$\(|\\$|;\s*$/,
        `${label}: a command-looking line outside the reviewed commands: ${line}`);
      assert.doesNotMatch(body, /^(?:sudo\s+)?[a-z][\w.-]*(?:\s+\S+)*?\s--?[A-Za-z]/,
        `${label}: a word followed by an option, outside the reviewed commands: ${line}`);
    }

    // R6-2: the Windows file search and a version mismatch are described by what they establish.
    assert.ok(!text.includes("where.exe"), `${label}: 'where.exe' is offered as showing what the shell runs`);
    const after = text.slice(orchestrator);
    for (const phrase of ["`Get-Command telepty` shows the command PowerShell selects",
      "`where telepty` lists the files named telepty that it finds, not which one cmd runs"])
      assert.ok(after.includes(phrase), `${label}: the read after the upgrade does not say '${phrase}'`);
    const disagree = after.slice(after.indexOf("If they disagree"));
    for (const fact of ["that alone does not say why", "The daemon may have been started before step 1 and still be running",
      "The CLI and the daemon may come from different installations", "This document prescribes no command"])
      assert.ok(disagree.includes(fact), `${label}: "If they disagree" does not say '${fact}'`);
    assert.doesNotMatch(disagree, /then your shell or a service still selects|correct it/i,
      `${label}: "If they disagree" still reads a mismatch as one cause and directs a correction`);
  }
});
