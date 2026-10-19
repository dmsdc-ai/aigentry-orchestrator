import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

test("importing the dispatcher with unrelated argv is inert", () => {
  const moduleUrl = new URL("../../src/dispatch/cli.js", import.meta.url).href;
  const program = `process.argv = ['node','unrelated']; await import(${JSON.stringify(moduleUrl)}); console.log('loaded');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH, AIGENTRY_CLAUDE_OAUTH_TOKEN: "fixture-token" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "loaded\n");
  assert.equal(child.stderr, "");
});

test("direct native-only open-session refuses a sandbox attempt launcher before terminal effects", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "s2-open-route-"));
  const cli = fileURLToPath(new URL("../../src/session/open-session/cli.js", import.meta.url));
  const launcher = path.join(home, "sessions", "t-n", "sandbox", randomUUID(), "launcher.sh");
  try {
    fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const child = spawnSync(process.execPath, [cli, "--track", "t", "--name", "n", "--cwd", home,
      "--cli", launcher, "--launch-policy", "native-only"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", AIGENTRY_SLEEP_GUARD: "0" }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(child.status, 78, child.stderr);
    assert.match(child.stderr, /ENV_MANAGED_ROUTE_REFUSED/);
    const repeated = spawnSync(process.execPath, [cli, "--track", "t", "--name", "n", "--cwd", home,
      "--cli", launcher, "--launch-policy", "managed-secret", "--launch-policy", "native-only"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", AIGENTRY_SLEEP_GUARD: "0" }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(repeated.status, 78, repeated.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("public env run owns a delayed pipe before rejecting an unsupported managed route", async () => {
  const entry = fileURLToPath(new URL("../../../bin/init/cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, "env", "run", "--binding", randomUUID(), "--input-fd", "3", "--",
    "dispatch", "--spawn-and-dispatch", "--cli", "claude", "--target", "other"], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { HOME: os.tmpdir(), PATH: "/usr/bin:/bin", AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined },
  });
  let exited = false, stderr = "";
  child.once("exit", () => { exited = true; });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(exited, false);
  const pipe = child.stdio[3];
  if (!(pipe instanceof Writable)) throw new Error("fixture pipe unavailable");
  pipe.end("fixture-token\n");
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  assert.equal(code, 78, stderr);
  assert.match(stderr, /ENV_MANAGED_ROUTE_REFUSED/);
  assert.doesNotMatch(stderr, /fixture-token/);
});
