// ADR-MF #13 — semverGte hand-rolled comparator (Article 17 — no semver dep).
import { test } from "node:test";
import assert from "node:assert/strict";
import { semverGte } from "../../../src/session/boot-adapter/index.js";

test("14. semverGte boundary cases", () => {
  // exact equality
  assert.equal(semverGte("0.1.0", "0.1.0"), true);
  assert.equal(semverGte("1.0.0", "1.0.0"), true);
  // major / minor / patch lower
  assert.equal(semverGte("0.0.9", "0.1.0"), false);
  assert.equal(semverGte("1.2.3", "1.2.4"), false);
  assert.equal(semverGte("0.9.0", "1.0.0"), false);
  // higher
  assert.equal(semverGte("2.0.0", "1.9.9"), true);
  assert.equal(semverGte("1.0.1", "1.0.0"), true);
  // prerelease less than release at same core
  assert.equal(semverGte("0.1.0-rc.1", "0.1.0"), false);
  assert.equal(semverGte("1.0.0-beta", "1.0.0"), false);
  // release greater than prerelease at same core
  assert.equal(semverGte("0.1.0", "0.1.0-rc.1"), true);
  // higher core trumps prerelease flag
  assert.equal(semverGte("1.0.0", "0.9.9-rc.1"), true);
});
