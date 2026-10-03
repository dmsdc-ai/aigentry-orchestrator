// Bounded init/boot adapter. Measurements detect drift, not authenticated provenance.
// The owner must keep these local files quiescent; no portable Node API defeats
// a hostile owner racing directory renames. Unknown operations require recovery.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as preservation from "./preservation.mjs";

export const NATIVE_FILES = [
  "bin/hook-prompt-submit.mjs", "bin/init/native-capture.mjs", "bin/init/preservation.mjs",
];
// Source import graph: wrapper -> cli -> receipt -> atomic-write, index-lock.
// Installed payloads are measured individually; missing compiled leaves refuse.
const PACKAGE_FILES = [
  "package.json", ...NATIVE_FILES,
  "dist/src/request-capture/cli.js", "dist/src/request-capture/receipt.js",
  "dist/src/session/persistence/atomic-write.js", "dist/src/session/persistence/index-lock.js",
];
const CONFIG_FILES = [".codex/hooks.json", ".aigentry-init.json"];
const LOCK = ".aigentry-native-capture.lock";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (reason) => { throw new Error(`Native capture refused: ${reason}`); };
const require = (condition, reason) => { if (!condition) fail(reason); };
const uid = () => process.getuid();

function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function absolute(file) {
  require(typeof file === "string" && path.isAbsolute(file) && file !== "/" &&
    path.normalize(file) === file && !file.endsWith("/") && !/[\x00-\x1f\x7f]/.test(file),
  "use canonical absolute paths without control characters");
}
function directory(file, privateRoot = false) {
  absolute(file);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const s = stat(current);
    require(s?.isDirectory() && !s.isSymbolicLink() &&
      (s.uid === 0n || s.uid === BigInt(uid())) && (Number(s.mode) & 0o022) === 0,
    "missing, symlinked or writable ancestor; provision canonical roots first");
  }
  const s = stat(file);
  require(fs.realpathSync.native(file) === file, "directory location changed");
  if (privateRoot) require(s.uid === BigInt(uid()) && (Number(s.mode) & 0o777) === 0o700,
    "capture and preservation roots must already be owner-controlled mode 0700");
  return { dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), mode: Number(s.mode) & 0o777 };
}
function metadata(s) {
  return { dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid), gid: Number(s.gid),
    mode: Number(s.mode) & 0o777, size: String(s.size), mtimeNs: String(s.mtimeNs) };
}
function read(file, packageFile = false) {
  const s = stat(file);
  if (!s) return null;
  directory(path.dirname(file));
  require(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n &&
    (s.uid === BigInt(uid()) || (packageFile && s.uid === 0n)) &&
    (Number(s.mode) & 0o7022) === 0, "unsafe file ownership, links or mode");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    require(same(metadata(s), metadata(fs.fstatSync(fd, { bigint: true }))), "file changed during open");
    const bytes = fs.readFileSync(fd);
    require(same(metadata(s), metadata(fs.fstatSync(fd, { bigint: true }))), "file changed during read");
    return { bytes, image: { ...metadata(s), hash: hash(bytes) }, atimeNs: String(s.atimeNs) };
  } finally { fs.closeSync(fd); }
}
function image(file, packageFile = false) { return read(file, packageFile)?.image ?? null; }
// Ownership baselines identify a canonical leaf's bytes, owner and mode. A
// verified restore uses a new inode; live transaction pre/postimages below still
// compare the full inode/mtime snapshot to refuse edits during apply or restore.
function baselineMatches(actual, expected) {
  return actual !== null && expected !== null && actual.hash === expected.hash &&
    actual.mode === expected.mode && actual.uid === expected.uid && actual.gid === expected.gid;
}
function sync(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function create(file, bytes, mode = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  sync(path.dirname(file));
}
function overlap(a, b) {
  a = a.normalize("NFC").toLowerCase(); b = b.normalize("NFC").toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function roots(request) {
  require(["darwin", "linux"].includes(process.platform), "native Windows remains unsupported");
  const { workspace, home, captureRoot, preservationRoot } = request;
  const ids = { workspace: directory(workspace), home: directory(home),
    capture: directory(captureRoot, true), backup: directory(preservationRoot, true) };
  const all = [workspace, home, captureRoot, preservationRoot];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    require(!overlap(all[i], all[j]), "workspace, home, capture and preservation roots must be disjoint");
  // crash-recovery.ts sweeps sessionsRoot recursively; the entire AIGENTRY_HOME
  // is excluded, including sessions/. cleanup-scheduler/cli.ts owns this override.
  if (process.env.DISPATCH_STATE_DIR) {
    const state = process.env.DISPATCH_STATE_DIR;
    absolute(state); directory(state);
    require(!overlap(state, captureRoot) && !overlap(state, preservationRoot), "cleanup root overlaps evidence");
  }
  const helper = { workspace, home, backup: preservationRoot };
  // Also enforces helper's owner/root identity and alias rules without writing.
  const pending = preservation.inspectPending({ roots: helper });
  return { ids, helper, pending };
}

export function assertNoNativeOperation(workspace, home) {
  for (const file of [path.join(workspace, LOCK),
    path.join(workspace, ".aigentry-preservation.lock"), path.join(home, ".aigentry-preservation.lock")])
    require(!stat(file), "pending operation; use explicit native inspection/recovery");
}
// Ordinary init also writes the shipped wrapper/adapter. Hold the same exclusive
// lock so a concurrent ordinary init cannot race first-time native registration.
export function beginLegacyInit(workspace, home) {
  assertNoNativeOperation(workspace, home);
  const lock = path.join(workspace, LOCK);
  fs.mkdirSync(lock, { mode: 0o700 });
  const identity = directory(lock, true);
  const owner = json({ kind: "legacy-init", operationId: randomUUID() });
  create(path.join(lock, "owner.json"), owner);
  return () => {
    require(same(directory(lock, true), identity) &&
      read(path.join(lock, "owner.json"))?.bytes.equals(owner), "init lock changed");
    fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); sync(workspace);
  };
}
function payload(packageRoot) {
  directory(packageRoot);
  return Object.fromEntries(PACKAGE_FILES.map((rel) => {
    const value = read(path.join(packageRoot, rel), true);
    require(value, "installed package leaf is missing");
    return [rel, value.image];
  }));
}
function quote(arg) { absolute(arg); return `'${arg.replaceAll("'", `'"'"'`)}'`; }
function definition(workspace, captureRoot, packageRoot, node) {
  const command = [node, path.join(workspace, NATIVE_FILES[0]), "--root", captureRoot,
    "--package-root", packageRoot].map((arg, index) => index === 2 || index === 4 ? arg : quote(arg)).join(" ");
  return json({ description: "aigentry native capture v1", hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command, timeout: 600 }] },
  ] } });
}
function stampAt(workspace) {
  const value = read(path.join(workspace, CONFIG_FILES[1]));
  return value ? JSON.parse(value.bytes.toString("utf8")) : null;
}
function verifyOutputs(workspace, outputs, baselineOnly = false) {
  require(outputs && same(Object.keys(outputs), NATIVE_FILES), "invalid owned output inventory");
  for (const rel of NATIVE_FILES) {
    const actual = image(path.join(workspace, rel));
    require(baselineOnly ? baselineMatches(actual, outputs[rel]) : same(actual, outputs[rel]),
      "owned package output changed; preserve foreign edits");
  }
}
function verifyInstalled(request, native, checkPackage = true) {
  require(native?.schemaVersion === 1 && native.workspace === request.workspace &&
    native.home === request.home && native.captureRoot === request.captureRoot &&
    native.preservationRoot === request.preservationRoot, "installation roots differ");
  const r = roots(request);
  require(same(r.ids, native.rootIdentities) && r.pending.length === 0, "root changed or preservation pending");
  verifyOutputs(request.workspace, native.outputs, true);
  const hook = read(path.join(request.workspace, CONFIG_FILES[0]));
  require(hook && baselineMatches(hook.image, native.registration) &&
    hook.bytes.equals(definition(native.workspace, native.captureRoot, native.packageRoot, native.node)),
  "registration is missing, shared or changed");
  if (checkPackage) {
    require(same(payload(native.packageRoot), native.packageFiles), "installed package moved or changed");
    require(same(image(native.node, true), native.nodeIdentity), "pinned Node changed");
  }
  return native;
}

/** Read-only preflight, also used for init --dry-run. */
export function prepareNativeCapture(request) {
  const r = roots(request);
  assertNoNativeOperation(request.workspace, request.home);
  require(r.pending.length === 0, "preservation operation pending");
  const beforeStamp = read(path.join(request.workspace, CONFIG_FILES[1]));
  const old = beforeStamp ? JSON.parse(beforeStamp.bytes.toString("utf8")).nativeCapture : null;
  if (old) {
    verifyInstalled(request, old, false);
    verifyNativeReceipt(request, old);
  }
  const hooks = read(path.join(request.workspace, CONFIG_FILES[0]));
  require(!hooks || old, "unowned/shared .codex/hooks.json collision; --force/--yes cannot replace it");
  const codex = path.join(request.workspace, ".codex");
  if (stat(codex)) directory(codex);
  const packageFiles = payload(request.packageRoot);
  const packageBefore = Object.fromEntries(NATIVE_FILES.map((rel) => [rel, image(path.join(request.workspace, rel))]));
  if (!old) for (const rel of NATIVE_FILES) require(!packageBefore[rel] ||
    (packageBefore[rel].hash === packageFiles[rel].hash && packageBefore[rel].mode === 0o755),
  "unowned package output differs; --force/--yes cannot replace it");
  const node = fs.realpathSync.native(process.execPath);
  const nodeIdentity = image(node, true);
  require(nodeIdentity, "Node executable missing");
  const bytes = definition(request.workspace, request.captureRoot, request.packageRoot, node);
  return { request: { ...request }, roots: r, old, beforeStamp, hooks, packageFiles, packageBefore,
    node, nodeIdentity, bytes, operationId: randomUUID() };
}

function operationDir(request, id) {
  require(UUID.test(id), "invalid native operation ID");
  return path.join(request.preservationRoot, `native-${id}`);
}
function save(tx) {
  require(same(directory(tx.dir, true), tx.record.operationDirectoryIdentity), "operation directory changed");
  const file = path.join(tx.dir, "operation.json");
  require(same(image(file), tx.journalImage ?? null), "journal changed");
  const bytes = json({ checksum: hash(json(tx.record)), record: tx.record });
  const stage = path.join(tx.dir, `journal-${randomUUID()}`);
  create(stage, bytes);
  fs.renameSync(stage, file); sync(tx.dir);
  tx.journalImage = image(file);
}
function ownLock(tx) {
  const lock = path.join(tx.record.workspace, LOCK);
  require(same(directory(lock, true), tx.record.lockIdentity), "native lock identity changed");
  const owner = read(path.join(lock, "owner.json"));
  require(owner && owner.bytes.equals(json({ operationId: tx.record.operationId,
    preservationRoot: tx.record.preservationRoot })), "native lock owner changed");
  require(same(roots(tx.record).ids, tx.record.rootIdentities), "root identity changed");
}
function release(tx) {
  ownLock(tx);
  const lock = path.join(tx.record.workspace, LOCK);
  fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); sync(tx.record.workspace);
}
function backup(tx, index, value) {
  if (value) create(path.join(tx.dir, `before-${index}`), value.bytes);
  return { before: value?.image ?? null, atimeNs: value?.atimeNs ?? null, after: null, restored: null };
}

/** Hold the fixed caller lock through legacy scaffolding and native commit. */
export function beginNativeCapture(prepared) {
  const { request, operationId } = prepared;
  // All source and preimage checks precede any native administrative write.
  assertNoNativeOperation(request.workspace, request.home);
  require(same(roots(request).ids, prepared.roots.ids) &&
    same(payload(request.packageRoot), prepared.packageFiles), "preflight changed");
  verifyOutputs(request.workspace, prepared.packageBefore);
  require(same(image(path.join(request.workspace, CONFIG_FILES[0])), prepared.hooks?.image ?? null) &&
    same(image(path.join(request.workspace, CONFIG_FILES[1])), prepared.beforeStamp?.image ?? null), "config changed");
  const lock = path.join(request.workspace, LOCK);
  fs.mkdirSync(lock, { mode: 0o700 }); sync(request.workspace);
  create(path.join(lock, "owner.json"), json({ operationId, preservationRoot: request.preservationRoot }));
  const dir = operationDir(request, operationId);
  fs.mkdirSync(dir, { mode: 0o700 }); sync(request.preservationRoot);
  fs.mkdirSync(path.join(dir, "executor"), { mode: 0o700 }); sync(dir);
  const tx = { dir, prepared, record: { schemaVersion: 1, operationId,
    workspace: request.workspace, home: request.home, captureRoot: request.captureRoot,
    preservationRoot: request.preservationRoot, rootIdentities: prepared.roots.ids,
    lockIdentity: directory(lock, true), operationDirectoryIdentity: directory(dir, true),
    phase: "preparing", packageOperation: null,
    packageBefore: null, packageAfter: null, packageRestored: null, configs: [] } };
  save(tx);
  tx.record.configs = [backup(tx, 0, prepared.hooks), backup(tx, 1, prepared.beforeStamp)];
  save(tx);
  return tx;
}

function replaceConfig(tx, index, bytes, mode, restoring = false) {
  ownLock(tx);
  const entry = tx.record.configs[index], target = path.join(tx.record.workspace, CONFIG_FILES[index]);
  const before = restoring ? entry.after : entry.before;
  require(same(image(target), before), "config changed before replacement");
  if (!restoring && before && before.hash === hash(bytes) && before.mode === mode) {
    entry.after = before; save(tx); return;
  }
  const parent = directory(path.dirname(target));
  if (bytes === null) {
    require(restoring && entry.before === null, "invalid config removal");
    fs.unlinkSync(target); sync(path.dirname(target));
    entry.restored = null; save(tx); return;
  }
  const stage = path.join(path.dirname(target), `.native-${tx.record.operationId}-${index}-${restoring ? "restore" : "apply"}`);
  create(stage, bytes, mode);
  if (restoring) {
    const fd = fs.openSync(stage, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      fs.fchownSync(fd, entry.before.uid, entry.before.gid);
      fs.fchmodSync(fd, entry.before.mode);
      fs.futimesSync(fd, Number(entry.atimeNs) / 1e9, Number(entry.before.mtimeNs) / 1e9);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  const expected = image(stage);
  entry[restoring ? "restored" : "after"] = expected;
  save(tx); // Durable expected postimage BEFORE the rename.
  ownLock(tx);
  require(same(directory(path.dirname(target)), parent) && same(image(target), before), "config parent or image changed");
  fs.renameSync(stage, target); sync(path.dirname(target));
  require(same(image(target), expected), "config postimage verification failed");
}

/** Package helper owns only package leaves and the declared .codex directory. */
export function commitNativeCapture(tx, stamp) {
  const p = tx.prepared, request = p.request;
  ownLock(tx);
  require(same(payload(request.packageRoot), p.packageFiles) &&
    same(image(p.node, true), p.nodeIdentity), "installed payload changed before apply");
  verifyOutputs(request.workspace, p.packageBefore);
  const entries = NATIVE_FILES.map((rel) => {
    const source = read(path.join(request.packageRoot, rel), true);
    require(source && same(source.image, p.packageFiles[rel]), "source changed while freezing package bytes");
    return { root: "workspace", path: rel, kind: "package", bytes: source.bytes, mode: 0o755,
      baseline: p.old ? { hash: p.old.outputs[rel].hash, mode: p.old.outputs[rel].mode } : null };
  });
  const codex = path.join(request.workspace, ".codex");
  if (stat(codex)) directory(codex);
  const input = { roots: p.roots.helper, sourceHash: hash(json(p.packageFiles)), entries,
    directories: stat(codex) ? [] : [{ root: "workspace", path: ".codex", mode: 0o700 }] };
  const plan = preservation.plan(input);
  require(plan.refusals.length === 0, "package collision; prior per-file ownership required");
  tx.record.packageOperation = { operationId: plan.operationId, planId: plan.planId };
  tx.record.packageBefore = Object.fromEntries(NATIVE_FILES.map((rel) => [rel, image(path.join(request.workspace, rel))]));
  tx.record.phase = "applying"; save(tx);
  const result = preservation.apply(plan, { input, decisions: [], validateReplacement: () => false });
  require(result.durabilityWarnings.length === 0, "package directory durability unavailable");
  tx.record.packageAfter = Object.fromEntries(NATIVE_FILES.map((rel) => [rel, image(path.join(request.workspace, rel))]));
  save(tx);
  replaceConfig(tx, 0, p.bytes, 0o600);
  const nativeCapture = { schemaVersion: 1, workspace: request.workspace, home: request.home,
    captureRoot: request.captureRoot, preservationRoot: request.preservationRoot,
    rootIdentities: p.roots.ids, packageRoot: request.packageRoot, packageFiles: p.packageFiles,
    node: p.node, nodeIdentity: p.nodeIdentity, outputs: tx.record.packageAfter,
    registration: tx.record.configs[0].after, definitionHash: hash(p.bytes),
    operationId: tx.record.operationId, packageOperation: tx.record.packageOperation,
    status: "installed/pending-review", provenance: "local-file-measurements-unverified" };
  replaceConfig(tx, 1, json({ ...stamp, nativeCapture }), 0o600);
  tx.record.phase = "committed"; save(tx);
  fs.rmdirSync(path.join(tx.dir, "executor")); sync(tx.dir);
  release(tx);
  return nativeCapture;
}

function loadOperation(request, id) {
  const r = roots(request), dir = operationDir(request, id);
  directory(dir, true);
  const raw = read(path.join(dir, "operation.json"));
  require(raw?.image.mode === 0o600, "missing private native journal");
  const envelope = JSON.parse(raw.bytes.toString("utf8")), record = envelope.record;
  require(HASH.test(envelope.checksum) && hash(json(record)) === envelope.checksum &&
    record?.schemaVersion === 1 && record.operationId === id &&
    record.workspace === request.workspace && record.home === request.home &&
    record.captureRoot === request.captureRoot && record.preservationRoot === request.preservationRoot &&
    same(record.rootIdentities, r.ids) && same(record.operationDirectoryIdentity, directory(dir, true)),
  "native journal identity mismatch");
  require(Array.isArray(record.configs) && record.configs.length === 2, "partial native preparation requires external recovery");
  for (let i = 0; i < 2; i++) if (record.configs[i].before) {
    const b = read(path.join(dir, `before-${i}`));
    require(b?.image.mode === 0o600 && b.image.hash === record.configs[i].before.hash,
      "missing or corrupt native backup");
  }
  return { dir, record, journalImage: raw.image, roots: r };
}
export function inspectNativeOperation(request, id) {
  const tx = loadOperation(request, id), op = tx.record.packageOperation;
  const packageStatus = op ? preservation.inspectOperation({ roots: tx.roots.helper, ...op }) : null;
  return { operationId: id, phase: tx.record.phase,
    executorBlocked: Boolean(stat(path.join(tx.dir, "executor"))),
    lockPresent: Boolean(stat(path.join(request.workspace, LOCK))), packageStatus };
}

function verifyNativeReceipt(request, native) {
  const status = inspectNativeOperation(request, native.operationId);
  require(status.phase === "committed" && !status.executorBlocked && !status.lockPresent &&
    status.packageStatus?.phase === "committed" && !status.packageStatus.executorBlocked &&
    status.packageStatus.durabilityWarnings.length === 0, "native operation not committed");
  const tx = loadOperation(request, native.operationId);
  require(same(native.packageOperation, tx.record.packageOperation) &&
    same(native.outputs, tx.record.packageAfter) && same(native.registration, tx.record.configs[0].after) &&
    baselineMatches(image(path.join(request.workspace, CONFIG_FILES[1])), tx.record.configs[1].after),
  "installation stamp or operation association changed");
}

export function restoreNativeOperation(request, id) {
  const tx = loadOperation(request, id), record = tx.record;
  require(!stat(path.join(tx.dir, "executor")), "active/interrupted native executor; external quiescence required");
  if (record.phase === "restored") {
    verifyOutputs(request.workspace, record.packageRestored);
    for (let i = 0; i < 2; i++) require(same(image(path.join(request.workspace, CONFIG_FILES[i])), record.configs[i].restored),
      "restored config changed");
    assertNoNativeOperation(request.workspace, request.home);
    return { operationId: id, phase: "restored" };
  }
  require(record.phase === "committed", "partial/unknown operation requires external recovery");
  assertNoNativeOperation(request.workspace, request.home);
  const packageStatus = preservation.inspectOperation({ roots: tx.roots.helper, ...record.packageOperation });
  require(packageStatus.phase === "committed" && !packageStatus.executorBlocked &&
    packageStatus.durabilityWarnings.length === 0, "package operation is not durably committed");
  verifyOutputs(request.workspace, record.packageAfter);
  // A committed helper operation has no stage/target locks. Refuse foreign
  // administrative leaves before disabling registration, not halfway through restore.
  for (const [index, rel] of NATIVE_FILES.entries()) {
    const parent = path.dirname(path.join(request.workspace, rel));
    const alias = path.basename(rel).normalize("NFC").toLowerCase();
    require(!stat(path.join(parent, `.aigentry-preservation-${hash(alias)}.lock`)), "package target lock is pending");
    for (const action of ["apply", "restore"]) require(!stat(path.join(parent,
      `.aigentry-preservation-${record.packageOperation.operationId}-${index}-${action}.tmp`)),
    "unexpected package stage; explicit recovery required");
  }
  for (let i = 0; i < 2; i++) require(same(image(path.join(request.workspace, CONFIG_FILES[i])), record.configs[i].after),
    "foreign config edit; restoration refused");
  // Helper-created .codex must become empty after registration restoration.
  if (packageStatus.directoryProgress.some((item) => item.state === "created"))
    require(fs.readdirSync(path.join(request.workspace, ".codex")).every((name) => name === "hooks.json"),
      "created .codex contains foreign files");
  const lock = path.join(request.workspace, LOCK);
  fs.mkdirSync(lock, { mode: 0o700 }); sync(request.workspace);
  create(path.join(lock, "owner.json"), json({ operationId: id, preservationRoot: request.preservationRoot }));
  record.lockIdentity = directory(lock, true);
  fs.mkdirSync(path.join(tx.dir, "executor"), { mode: 0o700 }); sync(tx.dir);
  record.phase = "restoring"; save(tx);
  // Registration is disabled/restored BEFORE the owned wrapper can disappear.
  const hook = record.configs[0];
  replaceConfig(tx, 0, hook.before ? read(path.join(tx.dir, "before-0")).bytes : null, hook.before?.mode, true);
  const result = preservation.restore({ roots: tx.roots.helper, ...record.packageOperation });
  require(result.durabilityWarnings.length === 0, "restore directory durability unavailable");
  record.packageRestored = Object.fromEntries(NATIVE_FILES.map((rel) => [rel, image(path.join(request.workspace, rel))]));
  const stamp = record.configs[1];
  replaceConfig(tx, 1, stamp.before ? read(path.join(tx.dir, "before-1")).bytes : null, stamp.before?.mode, true);
  record.phase = "restored"; save(tx);
  fs.rmdirSync(path.join(tx.dir, "executor")); sync(tx.dir);
  release(tx);
  return { operationId: id, phase: "restored" };
}

/** Never queries trust or labels a stamp/receipt as enabled native readiness. */
export function validateNativeBoot({ workspace, home }) {
  assertNoNativeOperation(workspace, home);
  const stamp = stampAt(workspace);
  if (!stamp?.nativeCapture) return null;
  const native = stamp.nativeCapture;
  const request = { workspace, home, captureRoot: native.captureRoot, preservationRoot: native.preservationRoot };
  verifyInstalled(request, native);
  verifyNativeReceipt(request, native);
  return { status: "installed/pending-review", source: path.join(workspace, CONFIG_FILES[0]),
    definitionHash: native.definitionHash };
}
