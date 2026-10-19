import * as path from "node:path";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import osDefault from "node:os";
import childDefault from "node:child_process";
import moduleDefault, { register, syncBuiltinESMExports } from "node:module";
import { assertFixtureSrtSpawn } from "./_srt-loader.js";
import { assertFixtureRoot } from "./fixture.js";

const root = process.env.R2_FIXTURE_ROOT;
try { assertFixtureRoot(root); }
catch { throw new Error("R2_FIXTURE_ROOT_REFUSED"); }
const host = path.join(root, "host"), central = path.join(host, ".aigentry");
const mode = process.env.R2_MODE;
if (mode !== "prepare" && mode !== "runner" && mode !== "revoke" && mode !== "terminal") throw new Error("R2_MODE_REFUSED");
const fixedBoot = "00000000-0000-4000-8000-000000000007";
const realRead = fsDefault.readFileSync;
fsDefault.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  if (args[0] === "/proc/sys/kernel/random/boot_id") return fixedBoot + "\n";
  return Reflect.apply(realRead, fsDefault, args);
}) as typeof fs.readFileSync;
const realSpawnSync = childDefault.spawnSync;
const swapTool = process.env.R2_SWAP === "1";
let swapped = false;
childDefault.spawnSync = ((...args: Parameters<typeof realSpawnSync>) => {
  if (args[0] === "/usr/sbin/sysctl" && Array.isArray(args[1]) && args[1][1] === "kern.bootsessionuuid") {
    return { status: 0, signal: null, stdout: fixedBoot + "\n", stderr: "", pid: 0, output: [] } as ReturnType<typeof realSpawnSync>;
  }
  const result = Reflect.apply(realSpawnSync, childDefault, args);
  if (mode === "terminal" && swapTool && !swapped && Array.isArray(args[1]) &&
      args[1].includes("detect-terminal")) {
    fsDefault.renameSync(path.join(root, "bin", "telepty-replacement"), path.join(root, "bin", "telepty"));
    swapped = true;
  }
  return result;
}) as typeof realSpawnSync;
osDefault.userInfo = (() => ({ username: "r2-fixture", uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0, shell: "/bin/sh", homedir: host })) as typeof osDefault.userInfo;
osDefault.homedir = (() => host) as typeof osDefault.homedir;
osDefault.tmpdir = (() => path.join(root, "tmp")) as typeof osDefault.tmpdir;
Date.now = () => 1_700_000_000_000;
osDefault.uptime = () => 1000;

if (mode === "runner") {
  const barrier = process.env.R2_BARRIER;
  register(new URL("./_srt-loader.js", import.meta.url), import.meta.url);
  const realCreateRequire = moduleDefault.createRequire;
  moduleDefault.createRequire = ((filename: string | URL) => {
    const request = realCreateRequire(filename);
    const realResolve = request.resolve.bind(request);
    request.resolve = ((id: string, options?: { paths?: string[] }) => id === "@anthropic-ai/sandbox-runtime/package.json"
      ? "/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/@anthropic-ai/sandbox-runtime/package.json"
      : realResolve(id, options)) as typeof request.resolve;
    return request;
  }) as typeof moduleDefault.createRequire;
  const info = JSON.parse(realRead(path.join(root, "managed-info.json"), "utf8")) as {
    manifest: string; provider: string; grantId: string };
  const manifest = JSON.parse(realRead(info.manifest, "utf8")) as { command: string[] };
  if (info.provider !== path.join(root, "bin", "claude") || manifest.command[0] !== info.provider) {
    throw new Error("R2_PROVIDER_REFUSED");
  }
  const trace = fsDefault.openSync(path.join(root, `runner-${process.pid}.jsonl`),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const record = (event: Record<string, unknown>): void => {
    fsDefault.writeSync(trace, JSON.stringify(event) + "\n"); fsDefault.fsyncSync(trace);
  };
  const clock = process.env.R2_CLOCK;
  if (clock && clock !== "normal") {
    const grant = JSON.parse(realRead(path.join(central, "environment", "grants", info.grantId, "grant.json"), "utf8")) as {
      issuedAt: number; expiresAt: number };
    const prepared = JSON.parse(realRead(path.join(central, "environment", "grants", info.grantId, "prepared.json"), "utf8")) as {
      clock: { issuedUptimeMs: number } };
    if (clock === "expiry") {
      Date.now = () => grant.expiresAt;
      osDefault.uptime = () => (prepared.clock.issuedUptimeMs + 300_000) / 1000;
    } else if (clock === "rollback") {
      Date.now = () => grant.issuedAt + 1000;
      osDefault.uptime = () => (prepared.clock.issuedUptimeMs - 2000) / 1000;
    } else throw new Error("R2_CLOCK_REFUSED");
    record({ boundary: "clock", mode: clock });
  }
  const realMkdir = fsDefault.mkdirSync;
  fsDefault.mkdirSync = ((file: fs.PathLike, options?: unknown) => {
    if (barrier === "race" && String(file) === path.join(central, "environment", "writer.lock")) {
      const ready = path.join(root, `ready-${process.pid}`);
      fsDefault.writeFileSync(ready, "ready\n", { flag: "wx", mode: 0o600 });
      record({ boundary: "pre-writer-lock", pid: process.pid });
      const release = path.join(root, "release");
      const until = process.hrtime.bigint() + 15_000_000_000n;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fsDefault.existsSync(release)) {
        if (process.hrtime.bigint() > until) throw new Error("R2_BARRIER_TIMEOUT");
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    return Reflect.apply(realMkdir, fsDefault, [file, options]);
  }) as unknown as typeof fs.mkdirSync;
  const realSpawn = childDefault.spawn;
  let wrappers = 0;
  childDefault.spawn = ((command: string, args?: readonly string[], options?: unknown) => {
    assertFixtureSrtSpawn(command, args, process.platform);
    if (wrappers >= 2) throw new Error("R2_FAKE_SRT_WRAPPER_REFUSED");
    const preflight = wrappers++ === 0;
    const target = preflight ? process.execPath : info.provider;
    const argv = preflight ? ["-e", "process.exit(0)"] : manifest.command.slice(1);
    const spawnOptions = options as { env?: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
    record({ boundary: preflight ? "mock-native-preflight" : "provider-spawn", target: preflight ? "node" : "owned-provider",
      selected: spawnOptions?.env?.CLAUDE_CODE_OAUTH_TOKEN === "fixture-token",
      other: Boolean(spawnOptions?.env?.AWS_SECRET_ACCESS_KEY), argv: preflight ? [] : argv,
      stdio: spawnOptions?.stdio });
    return Reflect.apply(realSpawn, childDefault, [target, argv, options]);
  }) as unknown as typeof realSpawn;
}
syncBuiltinESMExports();
