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
//      names it.
// and, because a future maintainer may have a real reason to depend on telepty again, it
// measures the GUARD that would then apply: a declared range that can resolve below the
// floor this orchestrator needs is refused by name. The floor is 0.11.1 — the first
// published telepty declaring `inject-bound-v1`, which src/dispatch/cli.ts requires for
// bound delivery to a busy worker (CHANGELOG 0.2.6 "Requirements").
//
// Node built-ins and two file reads only: no npm, no install, no network, no registry query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
 */
export function lowestResolvable(spec: string): Triple | null {
  const value = spec.trim();
  if (value === "" || /\|\||\s-\s|[<*]/.test(value)) return null;
  const match = /^(?:v|=|>=|>|\^|~)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
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
    "github:dmsdc-ai/aigentry-telepty", "file:../aigentry-telepty"];
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
});
