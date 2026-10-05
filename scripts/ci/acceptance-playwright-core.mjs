// #1177 the private playwright-core copy the browser/TLS acceptance loads, CI only. Not a product
// module and never shipped (`scripts/` is outside package.json `files`). It reuses the two-arm
// probe's exact arm-B mechanism - the SAME one-line crPage.js patch, the SAME pinned source and
// patched hashes, the SAME tree map - so the acceptance runs the library run 36323626280 measured:
// own-frame `Emulation.setFocusEmulationEnabled` enabled:true -> enabled:false and nothing else.
//
//   prepare  (no display) verify the pins, build the copy in RUNNER_TEMP, record the originals.
//   verify   (no display, after the run) the originals and the copy still match what was recorded.
//
// package.json, package-lock.json and node_modules are never written; the copy keeps the
// package's own LICENSE / NOTICE / ThirdPartyNotices files byte-identical. A pin that does not
// match - a Playwright upgrade included - is a named refusal, never an unpatched run. Output is
// closed reason names, counts, versions and sha256 digests only: no path or environment value.
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRPAGE_REL, PINS, ProbeFault, patchCrPage, sha256, treeDigest, treeMap } from './browser-visibility-probe.mjs';

/** The single explicit variable the CI job sets: the copy's directory, and nothing else. */
export const COPY_ENV = 'BROWSER_TLS_PLAYWRIGHT_CORE';
export const COPY_PINS = Object.freeze({
  playwright: PINS.playwright,
  chromiumRevision: PINS.chromiumRevision,
  chromiumVersion: PINS.chromiumVersion,
  crPage: PINS.crPage,
  crPagePatched: PINS.crPagePatched,
  packageLock: PINS.packageLock,
  // Measured by the probe's `prepare` in run 36323626280 from an `npm ci` of this same lock.
  installedTree: '573107a29408eed8a6be52c0dc9f2c2455ba8240cedae8a942fa744ef75dc686',
  installedFiles: 363,
  copyTree: '73962802549743e5f329df9e28ee988338c80c318b720a33e76000248d2cf3d3',
});
export const LICENSE_FILES = ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt'];

const fault = reason => { throw new ProbeFault(reason); };
const note = text => process.stderr.write(`acceptance-playwright-core: ${text}\n`);

/** Paths only; nothing here is printed. The copy has exactly one possible location. */
export function copyLayout(root, temp) {
  const state = join(temp, 'acceptance-playwright-core');
  return {
    packageJson: join(root, 'package.json'),
    packageLock: join(root, 'package-lock.json'),
    installed: join(root, 'node_modules/playwright-core'),
    state,
    stateFile: join(state, 'state.json'),
    copy: join(state, 'node_modules/playwright-core'),
  };
}

function requireRealDir(path, reason) {
  let stat;
  try { stat = lstatSync(path); } catch { fault(reason); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fault(reason);
}

function requirePins(dir, reason) {
  let pkg, browsers;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8'));
  } catch { fault(reason); }
  const chromium = (browsers.browsers || []).find(b => b.name === 'chromium') || {};
  if (pkg.name !== 'playwright-core' || pkg.version !== COPY_PINS.playwright
      || chromium.revision !== COPY_PINS.chromiumRevision
      || chromium.browserVersion !== COPY_PINS.chromiumVersion) fault(reason);
}

/** The untouched npm-ci original: exact version and exact tree, so an upgrade fails here. */
export function verifyInstalled(paths) {
  if (sha256(readFileSync(paths.packageLock)) !== COPY_PINS.packageLock) fault('package-lock-hash');
  requireRealDir(paths.installed, 'installed-missing');
  requirePins(paths.installed, 'installed-version');
  const map = treeMap(paths.installed);
  if (map.get(CRPAGE_REL) !== `f:${COPY_PINS.crPage}`) fault('installed-crpage-hash');
  if (map.size !== COPY_PINS.installedFiles || treeDigest(map) !== COPY_PINS.installedTree) fault('installed-tree-hash');
  return map;
}

/** The copy, re-read from disk: the one location, the pins, the exact patched tree, the notices. */
export function verifyCopy(root, temp, dir) {
  if (typeof temp !== 'string' || !isAbsolute(temp)) fault('runner-temp-unset');
  const paths = copyLayout(root, temp);
  if (typeof dir !== 'string' || dir !== paths.copy) fault('copy-path');
  requireRealDir(dir, 'copy-missing');
  requirePins(dir, 'copy-version');
  const map = treeMap(dir);
  if (map.get(CRPAGE_REL) !== `f:${COPY_PINS.crPagePatched}`) fault('copy-crpage-hash');
  if (!LICENSE_FILES.every(name => map.has(name))) fault('copy-notices-missing');
  const tree = treeDigest(map);
  if (map.size !== COPY_PINS.installedFiles || tree !== COPY_PINS.copyTree) fault('copy-tree-hash');
  return { tree, crPage: COPY_PINS.crPagePatched };
}

/** Every crPage.js this process has loaded must be the copy's, and there must be exactly one. */
export function verifyLoaded(dir) {
  const suffix = `${sep}playwright-core${sep}${CRPAGE_REL.split('/').join(sep)}`;
  const loaded = Object.keys(createRequire(import.meta.url).cache).filter(key => key.endsWith(suffix));
  if (loaded.length !== 1 || loaded[0] !== join(dir, CRPAGE_REL)) fault('loaded-crpage-not-copy');
}

export function prepare(paths) {
  const packageJson = sha256(readFileSync(paths.packageJson));
  const before = verifyInstalled(paths);
  const patched = patchCrPage(readFileSync(join(paths.installed, CRPAGE_REL), 'utf8'));
  // A pre-existing state directory belongs to somebody else: refuse it rather than reuse it.
  try { mkdirSync(paths.state, { recursive: false, mode: 0o700 }); } catch { fault('state-exists'); }
  mkdirSync(dirname(paths.copy), { recursive: true, mode: 0o700 });
  cpSync(paths.installed, paths.copy, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (treeDigest(treeMap(paths.copy)) !== treeDigest(before)) fault('copy-not-identical');
  writeFileSync(join(paths.copy, CRPAGE_REL), patched);
  const copied = treeMap(paths.copy);
  const differing = [...new Set([...before.keys(), ...copied.keys()])].filter(key => before.get(key) !== copied.get(key));
  if (differing.length !== 1 || differing[0] !== CRPAGE_REL) fault('copy-diff-not-single');
  if (!LICENSE_FILES.every(name => before.has(name) && copied.get(name) === before.get(name))) fault('copy-notices-missing');
  if (treeDigest(copied) !== COPY_PINS.copyTree) fault('copy-tree-hash');
  // The installed original is re-read after the copy was written: nothing touched it.
  if (treeDigest(treeMap(paths.installed)) !== COPY_PINS.installedTree) fault('installed-changed');
  const state = { packageJson, packageLock: COPY_PINS.packageLock, installedTree: COPY_PINS.installedTree,
    copyTree: COPY_PINS.copyTree, crPage: COPY_PINS.crPage, crPagePatched: COPY_PINS.crPagePatched };
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  note(`prepare (playwright-core=${COPY_PINS.playwright} chromium=${COPY_PINS.chromiumVersion}/r${COPY_PINS.chromiumRevision}`
    + ` package-json=${packageJson} package-lock=${COPY_PINS.packageLock} installed-tree=${COPY_PINS.installedTree}`
    + ` installed-files=${before.size} copy-tree=${COPY_PINS.copyTree} copy-diff=${CRPAGE_REL}`
    + ` crpage=${COPY_PINS.crPage} crpage-patched=${COPY_PINS.crPagePatched} notices=${LICENSE_FILES.length})`);
  return state;
}

/** After the run: every original and the copy still equal what `prepare` recorded and pinned. */
export function verifyAfter(root, paths) {
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  const checks = {};
  const probe = (name, run) => { try { checks[name] = run() !== false; } catch { checks[name] = false; } };
  probe('package-json', () => sha256(readFileSync(paths.packageJson)) === state.packageJson);
  probe('package-lock', () => sha256(readFileSync(paths.packageLock)) === state.packageLock);
  probe('installed-tree', () => verifyInstalled(paths) && true);
  probe('copy-tree', () => verifyCopy(root, dirname(paths.state), paths.copy) && true);
  note(`verify after-run (${Object.entries(checks).map(([key, ok]) => `${key}=${ok ? 'unchanged' : 'CHANGED'}`).join(' ')})`);
  return Object.values(checks).every(Boolean);
}

async function main(mode) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (!process.env.RUNNER_TEMP || !isAbsolute(process.env.RUNNER_TEMP)) fault('runner-temp-unset');
  const paths = copyLayout(root, process.env.RUNNER_TEMP);
  if (mode === 'prepare') { prepare(paths); return 0; }
  if (mode === 'verify') return verifyAfter(root, paths) ? 0 : 1;
  fault('mode');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(code => { process.exitCode = code; }, error => {
    note(`fault (reason=${error instanceof ProbeFault ? error.reason : 'unexpected'})`);
    process.exitCode = 1;
  });
}
