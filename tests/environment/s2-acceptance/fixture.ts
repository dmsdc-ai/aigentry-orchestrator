import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const tempRoot = fs.realpathSync.native(os.tmpdir());
const parent = path.join(tempRoot, `aigentry-s2-acceptance-${process.getuid?.() ?? "user"}`);
const processParent = path.join(parent, `process-${process.pid}-${randomUUID()}`);
const allocated = new Set<string>();
let processParentCreated = false;
const within = (child: string, root: string): boolean => child === root || child.startsWith(root + path.sep);
const packageRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const protectedRoots = fs.existsSync(path.join(packageRoot, "package.json"))
  ? [fs.realpathSync.native(packageRoot),
    ...(fs.existsSync(path.join(packageRoot, "node_modules"))
      ? [fs.realpathSync.native(path.join(packageRoot, "node_modules"))] : [])]
  : [];
const tempStat = fs.lstatSync(tempRoot);
assert.ok(tempStat.isDirectory() && !tempStat.isSymbolicLink() &&
  ((tempStat.uid === process.getuid?.() && (tempStat.mode & 0o077) === 0) ||
    (tempStat.uid === 0 && (tempStat.mode & 0o1002) === 0o1002)), "R2_FIXTURE_TEMP_REFUSED");
assert.ok(protectedRoots.every(root => !within(parent, root) && !within(root, parent)),
  "R2_FIXTURE_CONTROL_OVERLAP");

function privateDirectory(dir: string): void {
  const st = fs.lstatSync(dir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 &&
    (process.getuid?.() === undefined || st.uid === process.getuid()) &&
    fs.realpathSync.native(dir) === dir, "R2_FIXTURE_DIRECTORY_REFUSED");
}

export function assertFixtureRoot(root: string | undefined): asserts root is string {
  const processName = root && path.basename(path.dirname(root));
  const processMatch = processName && /^process-([0-9]+)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.exec(processName);
  assert.ok(root && path.isAbsolute(root) && path.normalize(root) === root &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(path.basename(root)) &&
    processMatch && (Number(processMatch[1]) === process.pid || Number(processMatch[1]) === process.ppid) &&
    path.dirname(path.dirname(root)) === parent, "R2_FIXTURE_ROOT_REFUSED");
  privateDirectory(parent);
  privateDirectory(path.dirname(root));
  privateDirectory(root);
}

export function fixture(): string {
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateDirectory(parent);
  if (!processParentCreated) {
    fs.mkdirSync(processParent, { mode: 0o700 });
    processParentCreated = true;
  }
  privateDirectory(processParent);
  const root = path.join(processParent, randomUUID());
  fs.mkdirSync(root, { mode: 0o700 });
  assertFixtureRoot(root);
  allocated.add(root);
  return root;
}

export function snapshot(root: string, name: string, value: unknown): void {
  assert.ok(allocated.has(root));
  assertFixtureRoot(root);
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  const file = path.join(root, `${name}.json`);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function publicEntry(): string {
  return fileURLToPath(new URL("../../../../bin/init/cli.mjs", import.meta.url));
}

export function childEnv(root: string): NodeJS.ProcessEnv {
  assert.ok(allocated.has(root));
  assertFixtureRoot(root);
  return { HOME: root, AIGENTRY_HOME: path.join(root, "central"), PATH: "/usr/bin:/bin",
    TMPDIR: tempRoot, LANG: "C", LC_ALL: "C", AIGENTRY_CLAUDE_OAUTH_TOKEN: undefined, NODE_OPTIONS: undefined,
    BASH_ENV: undefined };
}

export function invokeNode(file: string, args: string[], root: string,
  extra: NodeJS.ProcessEnv = {}, stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 15_000,
    stdio, env: { ...childEnv(root), ...extra } });
}

export function assertNoSourceLeak(result: SpawnSyncReturns<string>, source: string): void {
  assert.equal((result.stdout ?? "").includes(source), false);
  assert.equal((result.stderr ?? "").includes(source), false);
  assert.equal((result.output ?? []).some(part => typeof part === "string" && part.includes(source)), false);
}

export function finish(root: string, summary: unknown): void {
  snapshot(root, "trace", summary);
  const makeWritable = (dir: string): void => {
    assert.ok(within(dir, root), "R2_FIXTURE_DIRECTORY_REFUSED");
    const st = fs.lstatSync(dir);
    assert.ok(st.isDirectory() && !st.isSymbolicLink() &&
      (process.getuid?.() === undefined || st.uid === process.getuid()) &&
      fs.realpathSync.native(dir) === dir, "R2_FIXTURE_DIRECTORY_REFUSED");
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      assert.ok(opened.dev === st.dev && opened.ino === st.ino, "R2_FIXTURE_DIRECTORY_REFUSED");
      if ((opened.mode & 0o200) === 0) fs.fchmodSync(fd, opened.mode | 0o700);
    } finally { fs.closeSync(fd); }
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      if (fs.lstatSync(child).isDirectory()) makeWritable(child);
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
  allocated.delete(root);
  if (allocated.size === 0) {
    fs.rmdirSync(processParent);
    processParentCreated = false;
  }
}
