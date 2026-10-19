import test from "node:test";
import assert from "node:assert/strict";
import { acquireClaudeOAuthInput } from "../../src/session/claude-worker-oauth.js";
import { OwnedInput } from "../../src/environment/owned-input.js";
import { parseDispatchInvocation } from "../../src/environment/invocation.js";

test("fresh input is opaque, validates bytes, and consumes once", () => {
  const input = OwnedInput.fromBytes(Buffer.from("fixture-token", "ascii"));
  assert.equal(String(input), "[OwnedInput]");
  assert.throws(() => JSON.stringify(input), /ENV_INPUT_OPAQUE/);
  const bytes = input.consume();
  assert.equal(bytes.toString("ascii"), "fixture-token");
  bytes.fill(0);
  assert.throws(() => input.consume(), /ENV_INPUT_CONSUMED/);
  assert.throws(() => OwnedInput.fromBytes(Buffer.from("a\nb")), /ENV_INPUT_INVALID/);
  assert.throws(() => OwnedInput.fromBytes(Buffer.from("x".repeat(4097))), /ENV_INPUT_INVALID/);
});

test("repeated security selectors are rejected by the one parsed invocation", () => {
  assert.throws(() => parseDispatchInvocation(["--cli", "claude", "--cli", "claude"]), /ENV_DUPLICATE_OPTION/);
  assert.throws(() => parseDispatchInvocation(["--binding", "one", "--binding", "two"]), /ENV_DUPLICATE_OPTION/);
  assert.throws(() => parseDispatchInvocation(["--cwd", "--role"]), /ENV_/);
});

// E1/E3: the original selector feeds the opaque producer without serializing its source.
test("explicit acquisition keeps source kind ephemeral and rejects invalid input without store fallback", () => {
  const selected = acquireClaudeOAuthInput({ AIGENTRY_CLAUDE_OAUTH_TOKEN: "FAKE-explicit-input" });
  assert.equal(selected.kind, "explicit");
  assert.ok(selected.input);
  assert.throws(() => JSON.stringify(selected.input), /ENV_INPUT_OPAQUE/);
  const bytes = selected.input.consume();
  assert.equal(bytes.toString("ascii"), "FAKE-explicit-input");
  bytes.fill(0);
  assert.throws(() => selected.input!.consume(), /ENV_INPUT_CONSUMED/);
  for (const bad of ["two words", "line\nbreak", "x".repeat(4097)]) {
    assert.throws(() => acquireClaudeOAuthInput({ AIGENTRY_CLAUDE_OAUTH_TOKEN: bad }), /CLAUDE_OAUTH_|ENV_INPUT_INVALID/);
  }
});
