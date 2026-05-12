// ADR-MF #13 — registry contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BootAdapterError,
  CLI_KINDS,
  getBootAdapter,
} from "../../../src/session/boot-adapter/index.js";

test("1. registry returns adapter for each supported CLI", () => {
  for (const cli of CLI_KINDS) {
    const a = getBootAdapter(cli);
    assert.equal(a.name, cli);
    assert.match(a.min_version, /^\d+\.\d+\.\d+/);
  }
});

test("2. registry throws UNSUPPORTED_CLI for unknown CLI", () => {
  try {
    getBootAdapter("xyzzy");
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof BootAdapterError);
    assert.equal((e as BootAdapterError).code, "UNSUPPORTED_CLI");
  }
  for (const bad of ["", "Claude", "codex_v2"]) {
    assert.throws(() => getBootAdapter(bad), /UNSUPPORTED_CLI/);
  }
});
