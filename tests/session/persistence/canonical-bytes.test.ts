// ADR §4.8.2 — canonical bytes tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalBytes,
  canonicalTimestamp,
  sha256Hex,
} from "../../../src/session/persistence/canonical-bytes.js";

test("sorted-key invariance: same digest regardless of insertion order", () => {
  const a = { b: 1, a: 2, c: { y: 4, x: 3 } };
  const b = { a: 2, c: { x: 3, y: 4 }, b: 1 };
  assert.equal(sha256Hex(canonicalBytes(a)), sha256Hex(canonicalBytes(b)));
});

test("EOL normalization: CRLF and CR collapse to LF", () => {
  const lf = canonicalBytes("a\nb\nc");
  const crlf = canonicalBytes("a\r\nb\r\nc");
  const cr = canonicalBytes("a\rb\rc");
  assert.deepEqual(lf, crlf);
  assert.deepEqual(lf, cr);
});

test("BOM is stripped from string input", () => {
  const withBom = canonicalBytes("\uFEFFhello");
  const without = canonicalBytes("hello");
  assert.deepEqual(withBom, without);
});

test("NFC normalization: composed ≡ decomposed", () => {
  const composed = "café"; // U+00E9
  const decomposed = "cafe\u0301"; // U+0065 + U+0301
  assert.notEqual(composed, decomposed);
  assert.deepEqual(canonicalBytes(composed), canonicalBytes(decomposed));
});

test("different content yields different digest", () => {
  assert.notEqual(
    sha256Hex(canonicalBytes({ a: 1 })),
    sha256Hex(canonicalBytes({ a: 2 })),
  );
});

test("nested arrays preserved positionally; objects sorted recursively", () => {
  const value = {
    list: [{ z: 1, a: 2 }, { b: 3 }],
    meta: { gamma: "g", alpha: "a" },
  };
  const bytes = canonicalBytes(value);
  const text = new TextDecoder().decode(bytes);
  assert.equal(
    text,
    '{"list":[{"a":2,"z":1},{"b":3}],"meta":{"alpha":"a","gamma":"g"}}',
  );
});

test("scalars and null encoded canonically", () => {
  assert.equal(new TextDecoder().decode(canonicalBytes(null)), "null");
  assert.equal(new TextDecoder().decode(canonicalBytes(true)), "true");
  assert.equal(new TextDecoder().decode(canonicalBytes(42)), "42");
});

test("non-finite numbers rejected", () => {
  assert.throws(() => canonicalBytes(Number.NaN), /non-finite/);
  assert.throws(() => canonicalBytes(Number.POSITIVE_INFINITY), /non-finite/);
});

test("canonicalTimestamp emits explicit +00:00 offset", () => {
  const t = canonicalTimestamp(new Date("2026-05-12T15:30:00.000Z"));
  assert.equal(t, "2026-05-12T15:30:00.000+00:00");
});

test("sha256Hex deterministic on identical inputs", () => {
  const x = canonicalBytes({ k: "v" });
  assert.equal(sha256Hex(x), sha256Hex(x));
});
