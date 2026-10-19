import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";

const entry = fileURLToPath(new URL("../../../bin/init/cli.mjs", import.meta.url));
const uuid = "00000000-0000-4000-8000-000000000001";
const route = ["env", "run", "--binding", uuid, "--input-fd", "3", "--", "dispatch",
  "--spawn-and-dispatch", "--cli", "claude", "--target", "other"];

async function invoke(bytes: Buffer | string | null, argv = route, extra: NodeJS.ProcessEnv = {},
  fd3: "pipe" | "ignore" = "pipe"): Promise<{ code: number | null; stderr: string; stdout: string; home: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "s2-fd-matrix-"));
  try {
    const child = spawn(process.execPath, [entry, ...argv], {
      stdio: ["ignore", "pipe", "pipe", fd3],
      env: { HOME: home, AIGENTRY_HOME: path.join(home, "central"), PATH: "/usr/bin:/bin", ...extra },
    });
    let stderr = "", stdout = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    if (fd3 === "pipe") {
      const pipe = child.stdio[3];
      if (!(pipe instanceof Writable)) throw new Error("fixture FD3 missing");
      if (bytes !== null) pipe.end(bytes); // null deliberately holds the producer open.
      else setTimeout(() => pipe.end(), 10_250);
    }
    const code = await closed;
    assert.equal(fs.existsSync(path.join(home, "central")), false, "input rejection must precede staging");
    return { code, stderr, stdout, home };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("public owner rejects malformed frames before package initialization", async () => {
  for (const bytes of ["", "\n", "fixture", "bad\nsecond\n", "bad\r\n", "bad\u0000\n",
    "badé\n", "x".repeat(4097) + "\n"]) {
    const result = await invoke(bytes);
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /ENV_INPUT_INVALID/);
    assert.doesNotMatch(result.stderr + result.stdout, /fixture-token/);
  }
});

test("public owner rejects duplicate, conflicting, and unsupported nominated FDs", async () => {
  const duplicate = await invoke("fixture-token\n", ["env", "run", "--input-fd", "3",
    "--input-fd", "3", "--", "dispatch"]);
  assert.equal(duplicate.code, 4);
  assert.match(duplicate.stderr, /ENV_DUPLICATE_OPTION/);
  const conflict = await invoke("fixture-token\n", route, { AIGENTRY_CLAUDE_OAUTH_TOKEN: "other-token" });
  assert.equal(conflict.code, 4);
  assert.match(conflict.stderr, /ENV_INPUT_CONFLICT/);
  const empty = await invoke("fixture-token\n", route, { AIGENTRY_CLAUDE_OAUTH_TOKEN: "" });
  assert.equal(empty.code, 4);
  assert.match(empty.stderr, /CLAUDE_OAUTH_TOKEN_INVALID/);
  const unsupported = await invoke("fixture-token\n", route.map(v => v === "3" ? "0" : v));
  assert.equal(unsupported.code, 4);
  assert.match(unsupported.stderr, /ENV_INPUT_CHANNEL_UNSUPPORTED/);
  const absent = await invoke(null, route, {}, "ignore");
  assert.equal(absent.code, 4);
  assert.match(absent.stderr, /ENV_INPUT_CHANNEL_UNSUPPORTED|ENV_INPUT_INVALID/);
});

test("public owner times out an open producer without importing package helpers", { timeout: 13_000 }, async () => {
  const result = await invoke(null);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /ENV_INPUT_TIMEOUT/);
});

test("a valid 4096-byte frame reaches the same route without retaining source in diagnostics", async () => {
  const token = "T".repeat(4096);
  const result = await invoke(token + "\n");
  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /ENV_MANAGED_ROUTE_REFUSED/);
  assert.doesNotMatch(result.stderr + result.stdout, /TTTTTTTT/);
});

test("dispatch.sh compatibility route preserves an explicitly empty source as an invalid input", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "s2-dispatch-compat-"));
  const shim = fileURLToPath(new URL("../../../bin/dispatch.sh", import.meta.url));
  try {
    const result = spawnSync("/bin/bash", [shim, "--help"], {
      encoding: "utf8", timeout: 5000,
      env: { HOME: home, AIGENTRY_HOME: path.join(home, "central"),
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, AIGENTRY_CLAUDE_OAUTH_TOKEN: "" },
    });
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /ENV_INPUT_INVALID/);
    assert.equal(fs.existsSync(path.join(home, "central")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
