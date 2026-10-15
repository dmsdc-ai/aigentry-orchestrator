// #652 — dispatch must not seal a shell wrapper as the worker's CLI executable. Measured 2026-10-08: inside
// cmux, PATH's first `claude` is a bash shim that execs a wrapper outside the sandbox's read allowlist; the
// resolver bound it (version null, versionSource "unknown"), the manifest sealed it and the confined worker
// exited 127. The fixture shim below has that shape (a `#!/usr/bin/env bash` text script that execs another
// file); it is written, stat'ed and read, never executed. Hermetic: fake CLIs/HOME from model-router-fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, REPO } from "./model-router-fixtures.js";

const posix = process.platform === "darwin" || process.platform === "linux";
// Only darwin/linux seal a manifest; win32 refuses every confined spawn with SANDBOX_PLATFORM_UNSUPPORTED
// before any binding is used (asserted in managed-model-decision.test.ts), so these cases register on POSIX only.
const posixTest = posix ? test : (() => undefined) as unknown as typeof test;

const SHIM = `#!/usr/bin/env bash
wrapper="/Applications/cmux.app/Contents/Resources/bin/cmux-claude-wrapper"
if [[ -x "$wrapper" ]]; then
    exec "$wrapper" "$@"
fi
exec claude "$@"
`;

function writeShim(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "claude");
  writeFileSync(file, SHIM, { mode: 0o755 });
  return file;
}

function bindingOf(file: string, versionSource = "unknown", version: string | null = null) {
  const realpath = realpathSync(file), st = statSync(realpath);
  return { cli: "claude", path: file, realpath, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, version, versionSource };
}

// Host PATH minus every directory holding a claude/codex: the resolver must only ever see the shim and fakes.
function cleanHostPath(): string {
  return (process.env.PATH ?? "").split(delimiter).filter((d) => d && !["claude", "codex"].some((c) => {
    try { accessSync(join(d, c), constants.X_OK); return true; } catch { return false; }
  })).join(delimiter);
}

posixTest("prepareWorkerSandbox refuses a #! wrapper with unknown version (SANDBOX_CLI_WRAPPER) before any staging", async () => {
  const f = fixture();
  try {
    const sandbox = await import(pathToFileURL(join(REPO, "dist/src/session/worker-sandbox.js")).href);
    const shim = writeShim(join(f.root, "cmux-cli-shims"));
    const scope = { version: 1, task: "1083", sid: "router-fixture", read: [join(f.root, "project")],
      write: [join(f.root, "project")], domains: [] };
    const staging = join(f.root, "staging");
    mkdirSync(staging);
    assert.throws(() => sandbox.prepareWorkerSandbox(scope, "claude", join(f.root, "project"), [shim, "--model", "m"], staging,
      join(f.root, "project"), undefined, undefined, bindingOf(shim)),
    (e: Error) => e.message.startsWith(`SANDBOX_CLI_WRAPPER: ${JSON.stringify(shim)} `) &&
      e.message.includes("put the real claude binary first on PATH"));
    assert.deepEqual(readdirSync(staging), [], "refused before any staging write");
    // The existing identity check still runs first: a binding that no longer names this file is SANDBOX_EXECUTABLE_CHANGED.
    const stale = { ...bindingOf(shim), ino: statSync(shim).ino + 1 };
    assert.throws(() => sandbox.prepareWorkerSandbox(scope, "claude", join(f.root, "project"), [shim, "--model", "m"], staging,
      join(f.root, "project"), undefined, undefined, stale), /SANDBOX_EXECUTABLE_CHANGED/);
    assert.deepEqual(readdirSync(staging), [], "refused before any staging write");
  } finally { f.cleanup(); }
});

test("assertNotCliWrapper: only a shell #! text script with versionSource unknown is a wrapper", async () => {
  const f = fixture();
  try {
    const { assertNotCliWrapper } = await import(pathToFileURL(join(REPO, "dist/src/session/worker-sandbox.js")).href);
    const shim = writeShim(join(f.root, "cmux-cli-shims"));
    assert.throws(() => assertNotCliWrapper(bindingOf(shim)), /^Error: SANDBOX_CLI_WRAPPER: /);
    // Version evidence means the resolver identified a real install (e.g. npm's `#!/usr/bin/env node` cli.js): kept.
    assert.doesNotThrow(() => assertNotCliWrapper(bindingOf(shim, "npm-package-metadata", "2.1.198")));
    assert.doesNotThrow(() => assertNotCliWrapper(bindingOf(shim, "operator-declared", "2.1.198")));
    // A `#!/usr/bin/env node` script with unknown version is NOT refused: node/python wrappers are deliberately
    // out of scope until the resolver can follow them (task 652); only shell interpreters are refused.
    const nodeScript = join(f.root, "node-cli", "claude");
    mkdirSync(join(f.root, "node-cli"));
    writeFileSync(nodeScript, "#!/usr/bin/env node\nrequire('node:child_process').spawnSync('/elsewhere/claude', process.argv.slice(2));\n", { mode: 0o755 });
    assert.doesNotThrow(() => assertNotCliWrapper(bindingOf(nodeScript)));
    // A native executable (no `#!`, binary bytes) with unknown version is not a wrapper.
    const native = join(f.root, "native", "claude");
    mkdirSync(join(f.root, "native"));
    writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x00, 0x00]), { mode: 0o755 });
    assert.doesNotThrow(() => assertNotCliWrapper(bindingOf(native)));
    // `#!` followed by binary bytes is not a text script.
    const binary = join(f.root, "native", "codex");
    writeFileSync(binary, Buffer.concat([Buffer.from("#!"), Buffer.from([0x00, 0x01, 0x02])]), { mode: 0o755 });
    assert.doesNotThrow(() => assertNotCliWrapper({ ...bindingOf(binary), cli: "codex" }));
  } finally { f.cleanup(); }
});

posixTest("dispatch: a #! shim first on PATH is refused SANDBOX_CLI_WRAPPER (exit 78), naming it; nothing is spawned or sealed", () => {
  const f = fixture();
  try {
    const shim = writeShim(join(f.root, "cmux-cli-shims"));
    const r = f.dispatch([...f.spawnArgs, "--cli", "claude", "--role", "coder"],
      { PATH: [join(f.root, "cmux-cli-shims"), f.bin, cleanHostPath()].join(delimiter), AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5" });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, new RegExp(`^dispatch\\.sh: SANDBOX_CLI_WRAPPER: ${JSON.stringify(shim).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} ` +
      "is a #! script wrapper, not the claude executable; put the real claude binary first on PATH; nothing was spawned$", "m"));
    assert.equal(existsSync(f.env.OPEN_LOG!), false, "no terminal opened");
    assert.equal(existsSync(join(f.aig, "sessions", "router-fixture", "sandbox-current.json")), false, "no sealed manifest");
    assert.equal(existsSync(f.env.WORK_LOG!), false, "no model/work execution");
  } finally { f.cleanup(); }
});
