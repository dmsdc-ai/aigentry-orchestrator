import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { assertRuntimeOverlaySupported, assertTrustedFile, assertTrustedTool, captureManagedRuntime,
  helperEnvironment, pinTrustedFile, trustedTool } from "../../src/environment/helper-env.js";

test("operation environments omit credential, preload, and unrelated helper canaries", { skip: process.platform === "win32" }, () => {
  const trusted = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-tools-")));
  try {
    const source = { HOME: "/untrusted", PATH: trusted, NODE_OPTIONS: "--require poison",
      BASH_ENV: "/poison", AIGENTRY_CLAUDE_OAUTH_TOKEN: "fixture-secret", TELEPTY: "/trusted/telepty" };
    const context = captureManagedRuntime(source, trusted);
    assert.equal(path.dirname(context.temporary), trusted);
    const verify = helperEnvironment(context, "verify", source);
    const control = helperEnvironment(context, "control", source);
    for (const env of [verify, control]) {
      assert.equal(env.AIGENTRY_CLAUDE_OAUTH_TOKEN, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.BASH_ENV, undefined);
      assert.equal(env.HOME, os.userInfo().homedir);
    }
    assert.equal(verify.TELEPTY, undefined);
    assert.equal(control.TELEPTY, "/trusted/telepty");
    assert.throws(() => helperEnvironment(context, "verify", source, { NODE_OPTIONS: "--require poison" }), /ENV_HELPER_INPUT_REFUSED/);
    fs.rmSync(context.temporary, { recursive: true, force: true });
    const absent = path.join(trusted, "not-yet-a-tool-dir");
    const withoutLatePath = captureManagedRuntime({ PATH: `${trusted}${path.delimiter}${absent}` }, trusted);
    assert.equal(withoutLatePath.base.PATH, trusted);
    fs.rmSync(withoutLatePath.temporary, { recursive: true, force: true });
  } finally { fs.rmSync(trusted, { recursive: true, force: true }); }
});

test("managed scratch requires a canonical owned private directory", { skip: process.platform === "win32" }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-scratch-")));
  const alias = path.join(base, "alias"), privateRoot = path.join(base, "private");
  try {
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    fs.symlinkSync(privateRoot, alias);
    assert.throws(() => captureManagedRuntime({ PATH: "/usr/bin:/bin", TMPDIR: privateRoot }, alias), /ENV_HELPER_SCRATCH_REFUSED/);
    fs.chmodSync(privateRoot, 0o755);
    assert.throws(() => captureManagedRuntime({ PATH: "/usr/bin:/bin" }, privateRoot), /ENV_HELPER_SCRATCH_REFUSED/);
    fs.chmodSync(privateRoot, 0o700);
    const context = captureManagedRuntime({ PATH: "/usr/bin:/bin", TMPDIR: "/untrusted" }, privateRoot);
    assert.equal(path.dirname(context.temporary), privateRoot);
    assert.equal(context.base.TMPDIR, context.temporary);
    fs.rmSync(context.temporary, { recursive: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("pinned fake SRT wrapper admits exact generated proxy fields and rejects unknown fields", { skip: process.platform === "win32" }, () => {
  const runtimeRoot = path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"));
  const manifestEnv = { TMPDIR: "/tmp/owned", CLAUDE_CODE_TMPDIR: "/tmp/owned" };
  const url = `http://srt:${"a".repeat(32)}@localhost:${process.platform === "linux" ? "3128" : "43434"}`;
  const generated = ["SANDBOX_RUNTIME=1", "TMPDIR=/tmp/owned",
    "NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    "no_proxy=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "GRPC_PROXY", "grpc_proxy"]
      .map(key => `${key}=${url}`), "GIT_CONFIG_PARAMETERS='http.proxyAuthMethod=basic'"];
  const words = process.platform === "linux"
    ? ["bwrap", ...generated.flatMap(item => { const at = item.indexOf("="); return ["--setenv", item.slice(0, at), item.slice(at + 1)]; }),
      "--", "/bin/bash", "-c", "true"]
    : ["env", ...generated,
      "/usr/bin/sandbox-exec", "-p", "fixture", "/bin/bash", "-c", "true"];
  const quote = (word: string) => /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(word)
    ? word : "'" + word.replace(/'/g, "'\"'\"'") + "'";
  const wrapped = { argv: ["/bin/bash", "-c", words.map(quote).join(" ")], env: manifestEnv };
  assert.doesNotThrow(() => assertRuntimeOverlaySupported(runtimeRoot, wrapped, manifestEnv));
  const bad = process.platform === "linux"
    ? [...words.slice(0, -4), "--setenv", "NODE_OPTIONS", "--require poison", ...words.slice(-4)]
    : ["env", "NODE_OPTIONS=poison", ...words.slice(1)];
  assert.throws(() => assertRuntimeOverlaySupported(runtimeRoot,
    { argv: ["/bin/bash", "-c", bad.map(quote).join(" ")], env: manifestEnv }, manifestEnv), /ENV_RUNTIME_OVERLAY_UNSUPPORTED/);
});

test("managed executable pin refuses a replaced same-path binary before a later child spawn", { skip: process.platform === "win32" }, () => {
  const tools = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-executable-pin-")));
  const file = path.join(tools, "telepty"), replacement = path.join(tools, "replacement");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const runtime = captureManagedRuntime({ PATH: tools }, tools);
  try {
    const pinned = trustedTool(runtime, "telepty");
    assert.equal(pinned, file);
    assert.doesNotThrow(() => assertTrustedTool(runtime, "telepty", file));
    fs.writeFileSync(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.renameSync(replacement, file);
    assert.throws(() => assertTrustedTool(runtime, "telepty", file), /ENV_HELPER_PATH_REFUSED/);
  } finally {
    fs.rmSync(runtime.temporary, { recursive: true, force: true });
    fs.rmSync(tools, { recursive: true, force: true });
  }
});

test("operation-specific script pin refuses a replaced interpreter input", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-script-pin-")));
  const script = path.join(root, "dispatch-registry.py"), next = path.join(root, "replacement.py");
  fs.writeFileSync(script, "print(1)\n", { mode: 0o700 });
  const runtime = captureManagedRuntime({ PATH: "/usr/bin:/bin" }, root);
  try {
    pinTrustedFile(runtime, "registry", script);
    assert.doesNotThrow(() => assertTrustedFile(runtime, "registry", script));
    fs.writeFileSync(next, "print(2)\n", { mode: 0o700 });
    fs.renameSync(next, script);
    assert.throws(() => assertTrustedFile(runtime, "registry", script), /ENV_HELPER_PATH_REFUSED/);
  } finally {
    fs.rmSync(runtime.temporary, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
