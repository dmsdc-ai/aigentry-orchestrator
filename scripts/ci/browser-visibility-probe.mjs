// #1177 two-arm browser visibility PROBE, CI only. Disposable diagnostic, not a product module,
// not an acceptance change and not adoption of any dependency change. It measures ONE variable:
// whether playwright-core's OWN main-frame `Emulation.setFocusEmulationEnabled {enabled:true}`
// (crPage.js, FrameSession._initialize) keeps a background tab `visible`.
//
//   prepare  (no display) verify pinned sources, write the bounded supervisor copy, build the
//            private RUNNER_TEMP playwright-core copy for arm B, record hashes BEFORE.
//   run      (inside xvfb-run, as the supervisor's one owned suite child) one arm, selected by
//            VISIBILITY_PROBE_ARM=A|B. Both arms run the SAME steps; only the library differs.
//   verify   (no display) hashes AFTER must equal BEFORE; summarize both arm results.
//
// Exit status of `run`: 0 result matched expectation and cleanup was clean; 3 the measured
// result CONTRADICTED the expectation; 4 matched but cleanup failed; 1 precondition/probe fault.
// Nothing here emulates visibility, fires a synthetic event, retries, or polls for a state:
// every reading is ONE read after a fixed settle. Output is closed enums, counts, versions and
// sha256 digests only - no path, URL, title, environment value or page content is printed.
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PINS = Object.freeze({
  node: 'v20.20.0',
  playwright: '1.58.2',
  chromiumRevision: '1208',
  chromiumVersion: '145.0.7632.6',
  // Extracted heredoc body of ci.yml's `cat >"$WM_SUPERVISOR" <<"PY"`, 10-space YAML indent removed.
  supervisor: '665e99c9f5bb9cc3779228460610a022f780ce9eb032406761c9d678423d01ba',
  // The same body with exactly SUITE_LINE -> PROBE_LINE and nothing else.
  supervisorCopy: 'da58a3d533d8f7cb381f12ebe627d9487a9fdce05e8247924cbfc42288ac8b5e',
  crPage: '08f14f9abc4bde5b36a0679889de05e8c3c0ebbf7e15c3bafc3639830e01c174',
  crPagePatched: '50dd7a05e01a71e24461ee1776b1aa4f8580d2ca6db2236a661fd8948c85625a',
  packageJson: 'a5b293836105f2a02072e1cb4214940c61ea2798c3c899e15a3e847222a40f5d',
  packageLock: 'beaea7f58b8f0e802ea6d072f62ab5964ecd44776ec3c569991b58a23256d720',
});
export const SUPERVISOR_START = '          cat >"$WM_SUPERVISOR" <<"PY"';
export const SUPERVISOR_END = '          PY';
// Whole lines, newline-anchored on both sides, at the supervisor's own 12-space indent.
export const SUITE_LINE = '\n            suite = subprocess.Popen(["npm", "run", "test:browser-tls"])\n';
export const PROBE_LINE = '\n            suite = subprocess.Popen(["node", "scripts/ci/browser-visibility-probe.mjs", "run"])\n';
export const CRPAGE_REL = 'lib/server/chromium/crPage.js';
export const FOCUS_ON = 'promises.push(this._client.send("Emulation.setFocusEmulationEnabled", { enabled: true }));';
export const FOCUS_OFF = 'promises.push(this._client.send("Emulation.setFocusEmulationEnabled", { enabled: false }));';

const OP_MS = 5000;        // bound on one CDP/page operation
const LAUNCH_MS = 20000;   // bound on the launch, same as the acceptance launch timeout
const CLOSE_MS = 10000;    // bound on context.close()
const SETTLE_MS = 2000;    // fixed settle before each single reading; never a poll, never repeated
const SLOT = '__visibilityProbe';
const FOCUS = 'Emulation.setFocusEmulationEnabled';

export class ProbeFault extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const fault = reason => { throw new ProbeFault(reason); };
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const countOf = (text, needle) => text.split(needle).length - 1;
const note = text => process.stderr.write(`visibility-probe: ${text}\n`);

/** The supervisor exactly as ci.yml's heredoc writes it: the lines strictly between the ONE
 *  start marker and the first terminator after it, each with the block's 10-space indent removed. */
export function extractSupervisor(ciText) {
  const lines = ciText.split('\n');
  const starts = lines.flatMap((line, i) => (line === SUPERVISOR_START ? [i] : []));
  if (starts.length !== 1) fault('supervisor-start-count');
  const end = lines.findIndex((line, i) => i > starts[0] && line === SUPERVISOR_END);
  if (end < 0) fault('supervisor-end-missing');
  const body = lines.slice(starts[0] + 1, end);
  if (body.some(line => line !== '' && !line.startsWith(' '.repeat(10)))) fault('supervisor-indent');
  const text = body.map(line => line.slice(10)).join('\n') + '\n';
  if (sha256(text) !== PINS.supervisor) fault('supervisor-hash');
  return text;
}

/** The bounded diagnostic copy: the owned suite child becomes this probe and NOTHING else changes,
 *  so readiness, XRes ownership, signals and the one cleanup path are the verified originals. */
export function supervisorCopy(supervisor) {
  if (sha256(supervisor) !== PINS.supervisor) fault('supervisor-hash');
  if (countOf(supervisor, SUITE_LINE) !== 1) fault('supervisor-suite-count');
  const copy = supervisor.replace(SUITE_LINE, PROBE_LINE);
  if (sha256(copy) !== PINS.supervisorCopy) fault('supervisor-copy-hash');
  return copy;
}

/** The ONE own-frame call, enabled:true -> enabled:false. Wrong source or match count fails. */
export function patchCrPage(source) {
  if (sha256(source) !== PINS.crPage) fault('crpage-source-hash');
  if (countOf(source, FOCUS_ON) !== 1) fault('crpage-match-count');
  if (countOf(source, 'setFocusEmulationEnabled') !== 1) fault('crpage-call-count');
  const patched = source.replace(FOCUS_ON, FOCUS_OFF);
  if (sha256(patched) !== PINS.crPagePatched) fault('crpage-patched-hash');
  return patched;
}

/** Deterministic per-entry map of a directory tree: relative posix path -> `f:<sha256>` for files,
 *  `l:<target>` for symlinks. Any other entry type is refused. */
export function treeMap(root) {
  const map = new Map();
  const walk = rel => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(root, child);
      if (entry.isSymbolicLink()) map.set(child, `l:${readlinkSync(full)}`);
      else if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) map.set(child, `f:${sha256(readFileSync(full))}`);
      else fault('tree-entry-type');
    }
  };
  walk('');
  return map;
}
export const treeDigest = map =>
  sha256([...map.keys()].sort().map(key => `${key} ${map.get(key)}\n`).join(''));

/** Paths only; nothing here is printed. */
export function layout(root, temp) {
  const state = join(temp, 'visibility-probe');
  return {
    root,
    ci: join(root, '.github/workflows/ci.yml'),
    packageJson: join(root, 'package.json'),
    packageLock: join(root, 'package-lock.json'),
    installed: join(root, 'node_modules/playwright-core'),
    state,
    stateFile: join(state, 'state.json'),
    supervisor: join(state, 'supervisor.py'),
    copy: join(state, 'arm-b/node_modules/playwright-core'),
    result: arm => join(state, `result-${arm}.json`),
  };
}

function requireRealDir(path, reason) {
  let stat;
  try { stat = lstatSync(path); } catch { fault(reason); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fault(reason);
}

function libraryFacts(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8'));
  const chromium = (browsers.browsers || []).find(b => b.name === 'chromium') || {};
  return { version: pkg.version, revision: chromium.revision, browserVersion: chromium.browserVersion };
}

export function prepare(paths) {
  if (process.version !== PINS.node) fault('node-version');
  const pkgHash = sha256(readFileSync(paths.packageJson));
  const lockHash = sha256(readFileSync(paths.packageLock));
  if (pkgHash !== PINS.packageJson) fault('package-json-hash');
  if (lockHash !== PINS.packageLock) fault('package-lock-hash');
  const ciHash = sha256(readFileSync(paths.ci));
  const copy = supervisorCopy(extractSupervisor(readFileSync(paths.ci, 'utf8')));

  requireRealDir(paths.installed, 'installed-missing');
  const facts = libraryFacts(paths.installed);
  if (facts.version !== PINS.playwright || facts.revision !== PINS.chromiumRevision
      || facts.browserVersion !== PINS.chromiumVersion) fault('installed-version');
  const before = treeMap(paths.installed);
  if (before.get(CRPAGE_REL) !== `f:${PINS.crPage}`) fault('installed-crpage-hash');
  const patched = patchCrPage(readFileSync(join(paths.installed, CRPAGE_REL), 'utf8'));

  mkdirSync(paths.state, { recursive: false, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  writeFileSync(paths.supervisor, copy, { flag: 'wx', mode: 0o600 });
  mkdirSync(dirname(paths.copy), { recursive: true, mode: 0o700 });
  cpSync(paths.installed, paths.copy, {
    recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
  });
  if (treeDigest(treeMap(paths.copy)) !== treeDigest(before)) fault('copy-not-identical');
  writeFileSync(join(paths.copy, CRPAGE_REL), patched);
  const copied = treeMap(paths.copy);
  const differing = [...new Set([...before.keys(), ...copied.keys()])]
    .filter(key => before.get(key) !== copied.get(key));
  if (differing.length !== 1 || differing[0] !== CRPAGE_REL
      || copied.get(CRPAGE_REL) !== `f:${PINS.crPagePatched}`) fault('copy-diff-not-single');
  // The installed original is re-read after the copy was written: nothing touched it.
  const after = treeMap(paths.installed);
  if (treeDigest(after) !== treeDigest(before)) fault('installed-changed');

  const state = {
    node: process.version, playwrightCore: facts.version, chromiumRevision: facts.revision,
    chromiumVersion: facts.browserVersion, ciYml: ciHash, supervisor: PINS.supervisor,
    supervisorCopy: sha256(copy), packageJson: pkgHash, packageLock: lockHash,
    installedTree: treeDigest(before), installedFiles: before.size,
    copyTree: treeDigest(copied), crPage: PINS.crPage, crPagePatched: PINS.crPagePatched,
  };
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  note(`prepare (node=${state.node} playwright-core=${state.playwrightCore}`
    + ` chromium=${state.chromiumVersion}/r${state.chromiumRevision} ci-yml=${state.ciYml}`
    + ` supervisor=${state.supervisor} supervisor-copy=${state.supervisorCopy}`
    + ` supervisor-diff-lines=1 package-json=${pkgHash} package-lock=${lockHash}`
    + ` installed-tree=${state.installedTree} installed-files=${state.installedFiles}`
    + ` copy-tree=${state.copyTree} copy-diff=${CRPAGE_REL} crpage=${PINS.crPage}`
    + ` crpage-patched=${PINS.crPagePatched} crpage-matches=1)`);
  return state;
}

// ---- measurement ---------------------------------------------------------------------------

const delay = ms => new Promise(done => setTimeout(done, ms));
export function bounded(promise, ms, reason) {
  let timer;
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new ProbeFault(reason)), ms); });
  return Promise.race([Promise.resolve(promise), expiry]).finally(() => clearTimeout(timer));
}
const stateOf = value => (value === 'visible' || value === 'hidden' ? value : 'other');
const windowStateOf = value => (['normal', 'minimized', 'maximized', 'fullscreen'].includes(value) ? value : 'other');
const countOfEvents = value => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000) : -1);

/** In the page: a passive counter of REAL visibilitychange events. Dispatches nothing. */
const ARM = slot => {
  if (window[slot]) return false;
  const probe = { count: 0, last: 'none' };
  document.addEventListener('visibilitychange', () => {
    probe.count += 1;
    probe.last = document.visibilityState;
  }, { passive: true });
  window[slot] = probe;
  return true;
};
/** In the page: one read of what the browser itself reports. */
const READ = slot => {
  const probe = window[slot];
  return {
    state: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(),
    count: probe ? probe.count : -1, last: probe ? probe.last : 'not-armed',
  };
};

async function reading(tab) {
  const raw = await bounded(tab.evaluate(READ, SLOT), OP_MS, 'read-failed');
  return {
    state: stateOf(raw && raw.state), hidden: raw && raw.hidden === true,
    focus: raw && raw.focus === true, count: countOfEvents(raw && raw.count),
    last: raw && ['visible', 'hidden', 'none'].includes(raw.last) ? raw.last : 'other',
  };
}
async function phase(page, other) {
  await delay(SETTLE_MS);
  return { page: await reading(page), other: await reading(other) };
}
async function windowsOf(sessions) {
  const infos = [];
  for (const session of sessions) {
    const info = await bounded(session.send('Browser.getWindowForTarget'), OP_MS, 'window-read-failed');
    infos.push({
      id: Number.isSafeInteger(info && info.windowId) ? info.windowId : null,
      state: windowStateOf(info && info.bounds && info.bounds.windowState),
    });
  }
  return {
    same: infos[0].id !== null && infos[0].id === infos[1].id,
    page: infos[0].state, other: infos[1].state,
  };
}

/** The ONE procedure both arms run. `chromium` is the arm's own playwright-core export. */
export async function measure(chromium, { profile, env }) {
  const result = { cleanup: { detach: 'not-run', close: 'not-run' } };
  let context = null;
  const sessions = [];
  try {
    context = await bounded(chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: false, chromiumSandbox: true, ignoreHTTPSErrors: false,
      env, timeout: LAUNCH_MS,
    }), LAUNCH_MS + OP_MS, 'launch-failed');
    const initial = context.pages();
    if (initial.length !== 1 || initial[0].url() !== 'about:blank') fault('initial-tab');
    const page = initial[0];
    const other = await bounded(context.newPage(), OP_MS, 'new-page-failed');
    if (other.url() !== 'about:blank' || context.pages().length !== 2) fault('second-tab');
    // The CURRENT public approach, identical in both arms: a NEW session per tab, {enabled:false}.
    for (const tab of [page, other]) {
      sessions.push(await bounded(context.newCDPSession(tab), OP_MS, 'session-failed'));
      await bounded(sessions.at(-1).send(FOCUS, { enabled: false }), OP_MS, 'public-focus-off-failed');
    }
    const version = await bounded(sessions[0].send('Browser.getVersion'), OP_MS, 'version-failed');
    result.browser = {
      version: String(version && version.product || '').replace(/^Chrome\//, ''),
      headless: /Headless/i.test(String(version && version.userAgent || '')) ? 'yes' : 'no',
    };
    if (result.browser.version !== PINS.chromiumVersion) fault('browser-version');
    if (result.browser.headless !== 'no') fault('browser-headless');
    result.windowsBefore = await windowsOf(sessions);
    if (!result.windowsBefore.same) fault('not-same-window');

    await bounded(page.bringToFront(), OP_MS, 'front-page-failed');
    await delay(SETTLE_MS);
    for (const tab of [page, other]) {
      if (await bounded(tab.evaluate(ARM, SLOT), OP_MS, 'arm-failed') !== true) fault('arm-failed');
    }
    result.pageFront = await phase(page, other);
    await bounded(other.bringToFront(), OP_MS, 'front-other-failed');
    result.otherFront = await phase(page, other);
    await bounded(page.bringToFront(), OP_MS, 'restore-failed');
    result.restored = await phase(page, other);
    result.windowsAfter = await windowsOf(sessions);
  } finally {
    // One cleanup path for every outcome: detach what this probe attached, then close the
    // context it launched. A failure is recorded, never thrown over the original fault.
    if (sessions.length) {
      result.cleanup.detach = 'ok';
      for (const session of sessions) {
        try { await bounded(session.detach(), OP_MS, 'detach'); } catch { result.cleanup.detach = 'failed'; }
      }
    }
    if (context) {
      try { await bounded(context.close(), CLOSE_MS, 'close'); result.cleanup.close = 'ok'; }
      catch { result.cleanup.close = 'failed'; }
    }
  }
  return result;
}

/** A: both tabs stay visible (the reproduced defect). B: page hidden after the switch, with a
 *  real event, and visible again after restore. Returns the list of contradicted expectations. */
export function contradictions(arm, r) {
  const found = [];
  if (r.pageFront.page.state !== 'visible') found.push('page-front-page-not-visible');
  if (arm === 'A') {
    if (r.otherFront.page.state !== 'visible') found.push('a-switched-page-not-visible');
    if (r.otherFront.page.count !== 0) found.push('a-switched-page-event-fired');
  } else {
    const hid = r.otherFront.page;
    if (hid.state !== 'hidden' || !hid.hidden) found.push('b-switched-page-not-hidden');
    if (hid.count < 1 || hid.last !== 'hidden') found.push('b-switched-page-no-hidden-event');
  }
  const back = r.restored.page;
  if (back.state !== 'visible' || back.hidden) found.push('restored-page-not-visible');
  if (arm === 'B' && (back.count <= r.otherFront.page.count || back.last !== 'visible')) {
    found.push('b-restored-page-no-visible-event');
  }
  return found;
}

const yn = value => (value ? 'yes' : 'no');
const tabLine = t => `${t.state}/hidden=${yn(t.hidden)}/focus=${yn(t.focus)}/events=${t.count}/last=${t.last}`;
export function render(arm, r) {
  const lines = [];
  if (r.browser) lines.push(`arm=${arm} browser (version=${r.browser.version} headless=${r.browser.headless})`);
  if (r.windowsBefore) {
    lines.push(`arm=${arm} windows (ownership=${r.windowsBefore.same ? 'same-window' : 'different'}`
      + ` before=page:${r.windowsBefore.page},other:${r.windowsBefore.other}`
      + (r.windowsAfter ? ` after=page:${r.windowsAfter.page},other:${r.windowsAfter.other}` : '') + ')');
  }
  for (const key of ['pageFront', 'otherFront', 'restored']) {
    if (r[key]) lines.push(`arm=${arm} ${key} (page=${tabLine(r[key].page)} other=${tabLine(r[key].other)})`);
  }
  lines.push(`arm=${arm} cleanup (detach=${r.cleanup.detach} close=${r.cleanup.close})`);
  return lines;
}

export async function runArm(arm, paths, env) {
  if (arm !== 'A' && arm !== 'B') fault('arm-unset');
  if (process.version !== PINS.node) fault('node-version');
  if (!env.DISPLAY || !env.XAUTHORITY) fault('display-unset');
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  const dir = arm === 'A' ? paths.installed : paths.copy;
  requireRealDir(dir, 'library-missing');
  const tree = treeDigest(treeMap(dir));
  if (tree !== (arm === 'A' ? state.installedTree : state.copyTree)) fault('library-tree-hash');
  const crPage = sha256(readFileSync(join(dir, CRPAGE_REL)));
  if (crPage !== (arm === 'A' ? PINS.crPage : PINS.crPagePatched)) fault('library-crpage-hash');
  const { chromium } = await import(pathToFileURL(join(dir, 'index.mjs')).href);
  const executable = sha256(readFileSync(chromium.executablePath()));
  note(`arm=${arm} library (source=${arm === 'A' ? 'npm-ci-untouched' : 'runner-temp-copy'}`
    + ` tree=${tree} crpage=${crPage} own-frame-focus=${arm === 'A' ? 'enabled-true' : 'enabled-false'}`
    + ` public-session-focus=enabled-false chromium-executable=${executable})`);
  const home = mkdtempSync(join(paths.state, `home-${arm}-`));
  const browserEnv = {
    PATH: env.PATH, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    DISPLAY: env.DISPLAY, XAUTHORITY: env.XAUTHORITY,
  };
  const result = await measure(chromium, { profile: join(home, 'profile'), env: browserEnv });
  // The crPage.js actually loaded must be this arm's, and only this arm's.
  const loaded = Object.keys(createRequire(import.meta.url).cache)
    .filter(key => key.endsWith(`${sep}playwright-core${sep}${CRPAGE_REL.split('/').join(sep)}`));
  if (loaded.length !== 1 || loaded[0] !== join(dir, CRPAGE_REL)) fault('loaded-crpage-not-arm');
  return result;
}

async function main(mode) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (!process.env.RUNNER_TEMP) fault('runner-temp-unset');
  const paths = layout(root, process.env.RUNNER_TEMP);
  if (mode === 'prepare') { prepare(paths); return 0; }
  if (mode === 'run') {
    const arm = process.env.VISIBILITY_PROBE_ARM;
    let result;
    try { result = await runArm(arm, paths, process.env); }
    catch (error) {
      const reason = error instanceof ProbeFault ? error.reason : 'unexpected';
      note(`arm=${arm === 'A' || arm === 'B' ? arm : 'unset'} fault (reason=${reason})`);
      return 1;
    }
    for (const line of render(arm, result)) note(line);
    const contradicted = contradictions(arm, result);
    const clean = result.cleanup.detach === 'ok' && result.cleanup.close === 'ok';
    const verdict = contradicted.length ? 'contradicted' : 'as-expected';
    const expected = arm === 'A' ? 'switched-page-visible,restored-visible' : 'switched-page-hidden,restored-visible';
    note(`arm=${arm} verdict (expected=${expected} result=${verdict}`
      + ` contradictions=${contradicted.join(',') || '-'} cleanup=${clean ? 'clean' : 'failed'})`);
    writeFileSync(paths.result(arm), JSON.stringify({ arm, verdict, contradicted, clean, result }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    return contradicted.length ? 3 : clean ? 0 : 4;
  }
  if (mode === 'verify') {
    const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
    const checks = {
      'installed-tree': treeDigest(treeMap(paths.installed)) === state.installedTree,
      'installed-crpage': sha256(readFileSync(join(paths.installed, CRPAGE_REL))) === PINS.crPage,
      'package-json': sha256(readFileSync(paths.packageJson)) === state.packageJson,
      'package-lock': sha256(readFileSync(paths.packageLock)) === state.packageLock,
      'ci-yml': sha256(readFileSync(paths.ci)) === state.ciYml,
    };
    note(`verify originals-after (${Object.entries(checks).map(([k, v]) => `${k}=${v ? 'unchanged' : 'CHANGED'}`).join(' ')})`);
    let ok = Object.values(checks).every(Boolean);
    for (const arm of ['A', 'B']) {
      let summary = 'missing';
      try {
        const r = JSON.parse(readFileSync(paths.result(arm), 'utf8'));
        const s = r.result.otherFront && r.result.otherFront.page, b = r.result.restored && r.result.restored.page;
        summary = `${r.verdict} switched-page=${s ? s.state : '-'} switched-events=${s ? s.count : '-'}`
          + ` restored-page=${b ? b.state : '-'} cleanup=${r.clean ? 'clean' : 'failed'}`;
        if (r.verdict !== 'as-expected' || !r.clean) ok = false;
      } catch { ok = false; }
      note(`verify arm=${arm} (${summary})`);
    }
    return ok ? 0 : 1;
  }
  fault('mode');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(code => { process.exitCode = code; }, error => {
    note(`fault (reason=${error instanceof ProbeFault ? error.reason : 'unexpected'})`);
    process.exitCode = 1;
  });
}
