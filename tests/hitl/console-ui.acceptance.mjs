// CI-only configured-Console acceptance logic. Imported by browser-tls.acceptance.mjs, which
// remains the single caller and owns the runner gate, TLS, WebAuthn, browser ownership,
// child processes, secrets, cleanup and the deadline. This file is deliberately NOT a second
// harness: every shared primitive arrives through `deps` from that caller.
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const consoleCallerPath = fileURLToPath(import.meta.url);
export const SCREENSHOTS = ['console-320.png', 'console-390.png', 'console-768.png', 'console-1440.png', 'console-zoom.png'];
export const CONSOLE_RECEIPT = 'console-ui-receipt.json';
export const CONSOLE_PORT = 18790;
export const REFUSAL_PORT = 18791;
// Configured-Console controls only. The 44 existing browser-tls controls are untouched.
export const CONSOLE_IDS = [
  'console-fixtures', 'console-unconfigured', 'console-invalid-config', 'console-login-ui',
  'console-projects-acl', 'console-forbidden', 'console-read-only', 'console-legacy-intact',
  'console-query-refusals', 'console-pagination', 'console-cursor-refusals', 'console-cursor-expired',
  'console-coverage-complete', 'console-coverage-partial', 'console-coverage-unavailable',
  'console-views-unavailable', 'console-views-ui', 'console-detail', 'console-deep-link',
  'console-reload-deep-link', 'console-no-leak', 'console-inert-markup', 'console-state-cleared',
  'console-single-flight', 'console-hidden-pause', 'console-responsive', 'console-artifacts',
];
const MAX_PNG = 2 * 1024 * 1024, MAX_RECEIPT = 64 * 1024, MAX_ARTIFACTS = 8 * 1024 * 1024;
const HIDDEN_WINDOW_MS = 18000;
// Diagnostics only. The CI log reports a phase label but no assertion identity, so the
// console phase publishes which stage it is in. This is a CLOSED enum of static names:
// no observed value, path, argument, markup, header, cookie, token or error text is ever
// derived from it, and no check anywhere reads it. Nothing below relaxes an assertion.
export const CONSOLE_STAGES = ['not-started', 'prepare-artifacts', 'fixtures', 'unconfigured',
  'invalid-config', 'service-ready', 'login-ui', 'api', 'leak', 'ui', 'reload-deep-link',
  'single-flight', 'lifecycle-window', 'responsive', 'state-cleared', 'artifacts', 'receipt'];
let currentStage = 'not-started';
export const consoleStage = () => currentStage;
export function setConsoleStage(name) {
  // A drifting stage name must fail loudly rather than mislabel a future failure.
  if (!CONSOLE_STAGES.includes(name)) throw new Error('acceptance_failed');
  currentStage = name;
  currentLoginSubstage = 'not-started';
  currentOp = 'not-started';
}
// The same closed-enum discipline, one level finer, and only inside `login-ui`. The stage
// alone cannot separate a failed guest precondition (the status and visibility waits before
// the click) from a failed credential ceremony (the workspace wait after it): both report
// `login-ui`. These names are static, no check reads one, and nothing here is an assertion.
export const LOGIN_SUBSTAGES = ['not-started', 'navigate', 'guest-status', 'guest-visibility',
  'credential-ceremony', 'workspace-rows', 'settled', 'route-hash', 'project-options',
  'chrome-visibility', 'filters-visibility', 'operation-text', 'coverage-text', 'status-text',
  'status-state', 'clean-dom', 'mark'];
let currentLoginSubstage = 'not-started';
export const loginSubstage = () => currentLoginSubstage;
export function setLoginSubstage(name) {
  if (!LOGIN_SUBSTAGES.includes(name)) throw new Error('acceptance_failed');
  currentLoginSubstage = name;
}
// Third level, same closed-enum discipline, for the stages that run AFTER `login-ui` and
// carry no substage at all: CI run 36058831812 reported stage `reload-deep-link` with
// substage `not-started`, which localizes the failure to a whole stage and to no wait
// inside it. These names mark the actual awaited/assertion boundaries of that stage and of
// the four remaining stages behind it, so one CI cycle names the operation rather than the
// stage. Static names only; nothing here is an assertion and no check anywhere reads one.
export const CONSOLE_OPS = ['not-started',
  'rdl-select-archived', 'rdl-goto', 'rdl-guest-status-wait', 'rdl-guest-visibility',
  'rdl-guest-hash', 'rdl-login-click', 'rdl-detail-wait', 'rdl-settled', 'rdl-detail-values',
  'rdl-back-click', 'rdl-back-rows-wait', 'rdl-back-settled', 'rdl-clean-dom', 'rdl-mark',
  'sf-refresh-click', 'sf-view-burst', 'sf-filters-submit', 'sf-view-final', 'sf-rows-wait',
  'sf-settled', 'sf-flight-check',
  'lw-stage-file', 'lw-churn-navigate', 'lw-churn-rows', 'lw-churn-settled', 'lw-cursor-before',
  'lw-rename', 'lw-other-page', 'lw-hidden-wait', 'lw-hidden-window', 'lw-polls-check',
  'lw-resume-front', 'lw-visible-wait', 'lw-resumed-response', 'lw-resumed-rows',
  'lw-resumed-settled', 'lw-cursor-expired', 'lw-restarted', 'lw-changed-detail',
  'lw-alpha-return', 'lw-alpha-rows', 'lw-alpha-settled',
  'rv-viewport', 'rv-root-font', 'rv-rows-wait', 'rv-layout', 'rv-clean-dom', 'rv-text-leak',
  'rv-screenshot', 'rv-png-size', 'rv-secret-scan', 'rv-write', 'rv-reset', 'rv-names', 'rv-mark',
  'sc-open-detail', 'sc-detail-wait', 'sc-settled', 'sc-logout-click', 'sc-signed-out-wait',
  'sc-workspace-hidden', 'sc-rows-cleared', 'sc-fields-cleared', 'sc-logout-hidden',
  'sc-revoked-tasks', 'sc-revoked-projects', 'sc-clean-dom', 'sc-mark'];
let currentOp = 'not-started';
export const consoleOp = () => currentOp;
export function setConsoleOp(name) {
  // Same loud failure as the stage setter: a drifting name must not mislabel a future run.
  if (!CONSOLE_OPS.includes(name)) throw new Error('acceptance_failed');
  currentOp = name;
}
// Privacy-safe state for the one stage CI actually stops in. `nav` is the status code of the
// document response the deep-link navigation already returned, and 0 when it returned no
// response at all - which is exactly how a same-document fragment navigation differs from a
// real reload. The rest are y/n/u flags and bounded counts latched from values the existing
// checks already compute; no hash, id, title, status text, markup, header or error text ever
// enters one, and no page operation, wait, request or timeout is added to obtain any of them.
let reloadNav = -1, reloadWorkspaceHidden = 'u', reloadGuestRows = -1, reloadHashMatch = 'u';
let reloadFields = -1, reloadArchiveMatch = 'u', reloadLifecycleMatch = 'u', reloadStatusMatch = 'u';
/** Static, clamped here a second time exactly like `renderLoginBoundary`. No check reads it. */
export function renderReloadDeepLink() {
  const countT = value => (Number.isSafeInteger(value) && value >= -1 && value <= 999 ? value : -1);
  const codeT = value => (Number.isSafeInteger(value) && value >= 0 && value <= 599 ? value : -1);
  const flagT = value => (['y', 'n', 'u'].includes(value) ? value : 'u');
  return 'nav=' + codeT(reloadNav) + ' workspace-hidden=' + flagT(reloadWorkspaceHidden)
    + ' guest-rows=' + countT(reloadGuestRows) + ' hash=' + flagT(reloadHashMatch)
    + ' fields=' + countT(reloadFields) + ' archive=' + flagT(reloadArchiveMatch)
    + ' lifecycle=' + flagT(reloadLifecycleMatch) + ' recorded-status=' + flagT(reloadStatusMatch);
}
// Diagnostics only, one level below the substage and only for the post-click wait that
// actual CI now reports (`login-ui` / `workspace-rows`). The substage names WHICH wait
// never satisfied; it cannot name WHY. These are the boundaries that one wait can be
// blocked behind, as a CLOSED enum. Nothing here is an assertion, no check reads one,
// and nothing here relaxes, skips, retries or lengthens any existing wait.
export const LOGIN_BOUNDARIES = ['not-captured', 'unavailable', 'ceremony-not-started',
  'signin-pending', 'credential-failure', 'auth-server-refusal', 'projects-refusal',
  'workspace-not-opened', 'workspace-rows-mismatch', 'indeterminate'];
// Route CLASSES only. The allowlist below is static test data; an observed URL is
// classified in memory and discarded on the same line. No URL, path, query, header,
// body, cookie, token or error string is ever retained or printed.
export const ROUTE_CLASSES = ['auth-preauth', 'auth-login-options', 'auth-login-verify',
  'capabilities', 'projects', 'tasks', 'other'];
const EXACT_ROUTES = new Map([['/auth/preauth', 'auth-preauth'],
  ['/auth/login/options', 'auth-login-options'], ['/auth/login/verify', 'auth-login-verify'],
  ['/api/capabilities', 'capabilities'], ['/api/console/v1/projects', 'projects']]);
const TASKS_ROUTE = '/api/console/v1/tasks';
export function classifyRoute(pathname) {
  if (typeof pathname !== 'string') return 'other';
  const exact = EXACT_ROUTES.get(pathname);
  if (exact) return exact;
  return pathname === TASKS_ROUTE || pathname.startsWith(`${TASKS_ROUTE}/`) ? 'tasks' : 'other';
}
// The product renders a fixed set of literal status messages. The live text is compared
// against this exact allowlist INSIDE the page and only the class is returned, so the raw
// text never crosses back into Node and never enters a retained diagnostic object.
const STATUS_TEXTS = [
  ['Sign in with your passkey.', 'guest-prompt'],
  ['Signing in…', 'signing-in'],
  ['Creating passkey…', 'creating-passkey'],
  ['Loading…', 'loading'],
  ['Sign-in or enrollment failed. Retry with a supported passkey and valid invitation.', 'ceremony-failed'],
  ['Sign in required.', 'signin-required'],
  ['Forbidden: no access to this project.', 'forbidden-project'],
  ['Forbidden: no project grants configured.', 'forbidden-no-grants'],
  ['Source or service unavailable.', 'service-unavailable'],
  ['Recorded queue status · Execution and acceptance unknown.', 'ready-recorded'],
];
export const STATUS_CLASSES = ['absent', 'other', ...STATUS_TEXTS.map(pair => pair[1])];
export const STATUS_STATES = ['absent', 'unknown', 'authentication', 'loading', 'error',
  'forbidden', 'stale', 'offline', 'unavailable', 'ready', 'partial', 'complete'];
const OBSERVER_LIMIT = 200, PROBE_MS = 4000;
const emptyRoutes = () => Object.fromEntries(ROUTE_CLASSES.map(name =>
  [name, { seen: 0, ok: 0, refused: 0, failed: 0, code: 0 }]));
let routeTally = emptyRoutes(), observedPage = null, onResponse = null, onRequestFailed = null;
// Side-effect-free: the listeners only increment integers on a private tally. No Response,
// Request, URL or error object is retained; nothing is aborted, fulfilled, mutated or
// answered; no navigator API, product handler or credential path is patched. The tally is
// bounded by OBSERVER_LIMIT and never touches the caller's own response budget.
function startLoginObserver(page) {
  stopLoginObserver();
  routeTally = emptyRoutes();
  let total = 0;
  const bucket = value => {
    if (total >= OBSERVER_LIMIT) return null;
    total++;
    let pathname = null;
    try { pathname = new URL(value.url()).pathname; } catch { return null; }
    return routeTally[classifyRoute(pathname)];
  };
  onResponse = response => {
    const entry = bucket(response);
    if (!entry) return;
    entry.seen++;
    const code = response.status();
    if (!Number.isSafeInteger(code) || code < 100 || code > 599) return;
    entry.code = code;
    if (code < 400) entry.ok++; else entry.refused++;
  };
  onRequestFailed = request => { const entry = bucket(request); if (entry) entry.failed++; };
  observedPage = page;
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
}
// Removed with the page it was attached to: both listeners come off before `loginUI`
// returns or rethrows, so nothing survives into a later stage or the caller's cleanup.
function stopLoginObserver() {
  if (observedPage) {
    try { if (onResponse) observedPage.off('response', onResponse); } catch {}
    try { if (onRequestFailed) observedPage.off('requestfailed', onRequestFailed); } catch {}
  }
  observedPage = null; onResponse = null; onRequestFailed = null;
}
// Read-only DOM probe. It classifies in the page and returns closed-enum names, booleans
// and bounded counts only: no text, markup, attribute value, URL or error text escapes.
const PROBE = input => {
  const node = document.querySelector('#status');
  const pair = node ? input.texts.find(entry => entry[0] === node.textContent) : null;
  const state = node ? node.getAttribute('data-state') : null;
  const hidden = selector => { const found = document.querySelector(selector); return found ? found.hidden === true : null; };
  const count = selector => { const size = document.querySelectorAll(selector).length; return Number.isSafeInteger(size) && size >= 0 && size <= 999 ? size : -1; };
  return {
    statusClass: node ? (pair ? pair[1] : 'other') : 'absent',
    statusState: node ? (input.states.includes(state) ? state : 'unknown') : 'absent',
    workspaceHidden: hidden('#workspace'), authHidden: hidden('#auth'), logoutHidden: hidden('#logout'),
    rows: count('#requests li'), projectOptions: count('#project option'),
  };
};
// Pure and total, so the printed line can be re-derived by hand. Precedence follows the
// product's own order: the workspace either opened (then only the row set can be wrong),
// or the sign-in stopped at the server, at the projects grant, or at the ceremony itself.
export function deriveLoginBoundary(dom, routes) {
  if (!dom || typeof dom !== 'object') return 'unavailable';
  const tally = name => (routes && typeof routes === 'object' && routes[name]) || { seen: 0, ok: 0, refused: 0, failed: 0, code: 0 };
  const auth = ['auth-preauth', 'auth-login-options', 'auth-login-verify'];
  if (dom.workspaceHidden === false) return dom.rows === 25 ? 'indeterminate' : 'workspace-rows-mismatch';
  if (auth.some(name => tally(name).refused > 0 || tally(name).failed > 0)) return 'auth-server-refusal';
  if (tally('projects').refused > 0 || tally('projects').failed > 0
    || dom.statusClass === 'forbidden-no-grants') return 'projects-refusal';
  if (tally('auth-login-verify').ok > 0 || dom.logoutHidden === false) return 'workspace-not-opened';
  if (!auth.some(name => tally(name).seen > 0)) return 'ceremony-not-started';
  if (dom.statusClass === 'ceremony-failed' || dom.statusState === 'error') return 'credential-failure';
  if (dom.statusState === 'loading' || dom.statusClass === 'signing-in') return 'signin-pending';
  return 'indeterminate';
}
let boundarySnapshot = { captured: false, boundary: 'not-captured', dom: null, routes: emptyRoutes() };
export const loginBoundarySnapshot = () => boundarySnapshot;
/** Runs inside the failing stage, on the still-live owned page, BEFORE the caller closes
 *  that page or its context. It never throws, never checks, never marks and returns nothing
 *  the caller acts on: an unobservable page records `unavailable`, never success. */
export async function captureLoginBoundary(deps) {
  let dom = null;
  try { dom = await deps.bounded(deps.page.evaluate(PROBE, { texts: STATUS_TEXTS, states: STATUS_STATES }), PROBE_MS); }
  catch { dom = null; }
  try { boundarySnapshot = { captured: dom !== null && typeof dom === 'object', boundary: deriveLoginBoundary(dom, routeTally), dom, routes: routeTally }; }
  catch { boundarySnapshot = { captured: false, boundary: 'unavailable', dom: null, routes: emptyRoutes() }; }
}
const enumOf = (list, value) => (list.includes(value) ? value : 'unknown');
const countOf = value => (Number.isSafeInteger(value) && value >= 0 && value <= 999 ? value : -1);
const codeOf = value => (Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : 0);
const flagOf = value => (value === true ? 'y' : value === false ? 'n' : 'u');
/** Serialized only after the rejection, to stderr only. Every field is clamped here a
 *  second time, so an unexpected value renders `unknown` / `-1` / `0` rather than leaking. */
export function renderLoginBoundary(value) {
  const snapshot = value && typeof value === 'object' ? value : {};
  const dom = snapshot.dom && typeof snapshot.dom === 'object' ? snapshot.dom : {};
  const routes = snapshot.routes && typeof snapshot.routes === 'object' ? snapshot.routes : {};
  const tally = ROUTE_CLASSES.filter(name => name !== 'tasks' && name !== 'other').map(name => {
    const entry = routes[name] && typeof routes[name] === 'object' ? routes[name] : {};
    return `${name}:${countOf(entry.seen)}.${countOf(entry.ok)}.${countOf(entry.refused)}.${countOf(entry.failed)}.${codeOf(entry.code)}`;
  }).join(',');
  return `boundary=${enumOf(LOGIN_BOUNDARIES, snapshot.boundary)} captured=${flagOf(snapshot.captured)}`
    + ` status=${enumOf(STATUS_CLASSES, dom.statusClass)}/${enumOf(STATUS_STATES, dom.statusState)}`
    + ` hidden=w${flagOf(dom.workspaceHidden)}/a${flagOf(dom.authHidden)}/o${flagOf(dom.logoutHidden)}`
    + ` rows=${countOf(dom.rows)} options=${countOf(dom.projectOptions)} routes=${tally}`;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const outcomes = new Map();
const mark = (deps, id) => { deps.check(CONSOLE_IDS.includes(id) && !outcomes.has(id)); outcomes.set(id, 'pass'); deps.done(id); };
// Hostile fixture strings. None may reach the projection, the DOM, a log or a screenshot.
const PAYLOADS = [
  '<script>globalThis.__acceptanceXss=1</script>',
  '<img src="/__acceptance_attack__" onerror="globalThis.__acceptanceXss=1">',
  '<svg onload="globalThis.__acceptanceXss=1"></svg>',
  '</dd></button><iframe src="/__acceptance_attack__"></iframe>',
  '[clause](javascript:globalThis.__acceptanceXss=1) ![x](/__acceptance_attack__)',
];
const STATUSES = ['pending', 'queued', 'delegated', 'in_progress', 'blocked', 'blocked-by-observation', 'done', 'completed', 'failed', 'cancelled', 'superseded'];
const REASONS = ['recorded_status_only', 'execution_observation_unavailable', 'acceptance_unavailable', 'redacted_title_unavailable', 'model_effort_contract_unavailable', 'blocker_contract_unavailable'];
const TASK_WARNINGS = ['source_observation_time_unknown', 'execution_and_acceptance_not_covered'];
const PAGE_KEYS = ['schemaVersion', 'projectId', 'projectionRevision', 'sourceRevisions', 'observedAt', 'fetchedAt', 'generatedAt', 'currentness', 'coverage', 'warnings', 'items', 'total', 'nextCursor'];
const ROW_KEYS = ['taskId', 'projectId', 'revision', 'title', 'recordedStatus', 'archive', 'lifecycle', 'updatedAt', 'observedAt', 'attempt', 'sid', 'operation', 'phase', 'tool', 'surface', 'requestedModel', 'requestedEffort', 'observedModel', 'observedEffort', 'blocker', 'resumeOwner', 'release', 'reasons'];
const NULL_KEYS = ['title', 'observedAt', 'attempt', 'sid', 'operation', 'phase', 'tool', 'surface', 'requestedModel', 'requestedEffort', 'observedModel', 'observedEffort', 'blocker', 'resumeOwner', 'release'];
const DETAIL_TERMS = ['Task', 'Title', 'Recorded status', 'Archive membership', 'Lifecycle evidence', 'Source updated', 'Execution observed', 'Phase', 'SID / attempt / operation', 'Requested model / effort', 'Observed model / effort', 'Blocker / resume owner', 'Release / acceptance', 'Obligations / artifacts', 'Revision', 'Coverage reasons'];
const UNAVAILABLE_TERMS = ['Execution observed', 'Phase', 'SID / attempt / operation', 'Requested model / effort', 'Observed model / effort', 'Blocker / resume owner', 'Release / acceptance', 'Obligations / artifacts'];
const CONFIGURED = ['alpha', 'partialp', 'broken', 'churn', 'beta'];
const GRANTED = ['alpha', 'partialp', 'broken', 'churn'];

/** The oracle: the documented projection rule, restated here independently of product code. */
const expectRow = (row, projectId, archive) => ({
  taskId: row.id, projectId, archive,
  recordedStatus: STATUSES.includes(row.status) ? row.status : 'unknown',
  lifecycle: !archive && (row.status === 'pending' || row.status === 'queued') ? row.status : 'unknown',
  updatedAt: typeof row.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(row.updated_at)
    && Number.isFinite(Date.parse(row.updated_at)) ? row.updated_at : null,
});

export function artifactsDir(runnerTemp) { return join(runnerTemp ?? '', 'console-ui-artifacts'); }

/** Exactly one owned directory, under the already validated disposable runner root. */
export async function prepareArtifacts(deps) {
  setConsoleStage('prepare-artifacts');
  const { check, safeAncestors } = deps;
  const dir = artifactsDir(process.env.RUNNER_TEMP);
  check(process.env.CONSOLE_UI_ARTIFACTS === dir);
  await safeAncestors(process.env.RUNNER_TEMP);
  // `wx` semantics for a directory: a pre-existing path belongs to somebody else, so refuse it.
  await mkdir(dir, { mode: 0o700 });
  check(((await lstat(dir)).mode & 0o777) === 0o700);
  return { dir, receipt: join(dir, CONSOLE_RECEIPT) };
}

function queueRow(id, status, updated, index, secret) {
  return { id, status, updated_at: updated,
    title: `Task ${id} ${PAYLOADS[index % PAYLOADS.length]}`,
    note: `note ${PAYLOADS[(index + 1) % PAYLOADS.length]}`,
    prompt: `original prompt ${PAYLOADS[(index + 2) % PAYLOADS.length]}`,
    owner_path: '/absolute/private/should-never-be-exposed',
    secret };
}

/** Synthetic queues and an operator-owned config. No real user or host data is involved. */
export async function consoleFixtures(deps, root) {
  setConsoleStage('fixtures');
  const { check, privateDir, privateFile, remember } = deps;
  const dir = await privateDir(root);
  const secrets = [], spec = {};
  const token = name => { const value = remember(digest(`console-secret-${name}`).slice(0, 32)); secrets.push(value); return value; };
  const alphaTasks = [], alphaCompleted = [];
  for (let i = 0; i < 30; i++) {
    const id = `A${String(i + 1).padStart(3, '0')}`, archive = i >= 27;
    const status = i === 26 ? '<b>pending</b>' : archive ? ['done', 'completed', 'archived-oops'][i - 27] : STATUSES[i % STATUSES.length];
    const updated = ['2026-01-02', '2026-01-03T04:05:06.789Z', 'not-a-date', '2026-13-45'][i % 4];
    (archive ? alphaCompleted : alphaTasks).push(queueRow(id, status, updated, i, token(id)));
  }
  spec.alpha = { tasks: alphaTasks, completed: alphaCompleted, taskIds: [...alphaTasks, ...alphaCompleted].map(row => row.id) };
  spec.partialp = { taskIds: ['P001', 'P002', 'P003', 'P404'], completed: [],
    tasks: [queueRow('P001', 'queued', '2026-02-01', 0, token('P001')), queueRow('P002', 'blocked', '2026-02-02', 1, token('P002')),
      queueRow('P003', 'done', '2026-02-03', 2, token('P003')), queueRow('P003', 'failed', '2026-02-04', 3, token('P003b'))] };
  const churn = [];
  for (let i = 0; i < 6; i++) churn.push(queueRow(`C${String(i + 1).padStart(3, '0')}`, 'queued', '2026-03-01', i, token(`C${i}`)));
  spec.churn = { tasks: churn, completed: [], taskIds: churn.map(row => row.id) };
  spec.beta = { tasks: [queueRow('B001', 'pending', '2026-04-01', 0, token('B001'))], completed: [], taskIds: ['B001'] };
  const queues = {};
  for (const [id, entry] of Object.entries(spec)) {
    const path = join(dir, `${id}-queue.json`), body = JSON.stringify({ tasks: entry.tasks, completed: entry.completed });
    await privateFile(path, body);
    queues[id] = { path, digest: digest(body) };
  }
  const absent = join(dir, 'absent-queue.json');
  const config = {
    projects: [
      { id: 'alpha', taskQueue: queues.alpha.path, taskIds: spec.alpha.taskIds },
      { id: 'partialp', taskQueue: queues.partialp.path, taskIds: spec.partialp.taskIds },
      { id: 'broken', taskQueue: absent, taskIds: ['X001'] },
      { id: 'churn', taskQueue: queues.churn.path, taskIds: spec.churn.taskIds },
      // Configured on purpose and granted on purpose nowhere.
      { id: 'beta', taskQueue: queues.beta.path, taskIds: spec.beta.taskIds },
    ],
    grants: [{ principalId: 'inbox-owner', projects: [...GRANTED] }],
  };
  const configBody = JSON.stringify(config), configPath = join(dir, 'console.json');
  await privateFile(configPath, configBody);
  const relativeQueue = join(dir, 'console-relative.json'), noTls = join(dir, 'console-no-tls.json');
  await privateFile(relativeQueue, JSON.stringify({ projects: [{ id: 'alpha', taskQueue: 'relative/queue.json', taskIds: ['A001'] }], grants: [] }));
  await privateFile(noTls, configBody);
  check(secrets.length === 41 && new Set(secrets).size === 41);
  mark(deps, 'console-fixtures');
  return { dir, configPath, relativeQueue, noTls, absent, queues, spec, secrets,
    configDigest: digest(configBody), granted: [...GRANTED] };
}

/** An unconfigured service must say so, and must never synthesize a Console surface. */
export async function unconfiguredRefusal(deps, page, port) {
  setConsoleStage('unconfigured');
  const { check, fetchPage, request, certs } = deps;
  const capabilities = await fetchPage(page, '/api/capabilities');
  check(capabilities.json.console.state === 'unavailable' && capabilities.json.console.reason === 'not_configured');
  for (const path of ['/api/console/v1/tasks?project=alpha', '/api/console/v1/projects', '/api/console/v1/tasks/A001?project=alpha']) {
    const refused = await fetchPage(page, path);
    check(refused.status === 503 && refused.body === '{"error":"console_unavailable"}');
    const anonymous = await request(port, path, { ca: certs.ca });
    check(anonymous.status === 401 && anonymous.body === '{"error":"authentication_required"}');
  }
  mark(deps, 'console-unconfigured');
}

/** An invalid or under-privileged console configuration must refuse to open a listener. */
export async function invalidConfigRefusal(deps, fixtures, args) {
  setConsoleStage('invalid-config');
  const { check, child, terminate, request, bounded, certs } = deps;
  for (const [configPath, tls] of [[fixtures.relativeQueue, true], [fixtures.noTls, false]]) {
    const { proc, log } = child(process.execPath, [...args.base, '--port', String(REFUSAL_PORT),
      ...(tls ? ['--tls-key', certs.trusted.keyPath, '--tls-cert', certs.trusted.certPath] : []), '--console-config', configPath]);
    try {
      check(await bounded(proc.completed, 20000) === 1 && !log.overflow);
      const text = Buffer.concat(log.chunks).toString('utf8');
      check(text.includes('Inbox unavailable:') && !text.includes('Task Console'));
      let code;
      try { await request(REFUSAL_PORT, '/api/capabilities', { ca: certs.ca }); } catch (error) { code = error.code; }
      check(code === 'ECONNREFUSED');
    } finally { await terminate(proc); }
  }
  mark(deps, 'console-invalid-config');
}

function expectPage(deps, page, want) {
  const { check } = deps;
  check(JSON.stringify(Object.keys(page).sort()) === JSON.stringify([...PAGE_KEYS].sort()));
  check(page.schemaVersion === 1 && page.projectId === want.projectId && page.observedAt === null && page.currentness === 'unknown');
  check(page.coverage === want.coverage && JSON.stringify(page.warnings) === JSON.stringify(want.warnings));
  check(page.total === want.total && Number.isFinite(Date.parse(page.generatedAt)));
  check(want.cursor === 'any' ? typeof page.nextCursor === 'string' && page.nextCursor.includes('.') : page.nextCursor === want.cursor);
  if (want.revision === 'null') check(page.projectionRevision === null && page.fetchedAt === null && JSON.stringify(page.sourceRevisions) === '[]');
  else {
    check(/^[a-f0-9]{64}$/.test(page.projectionRevision) && Number.isFinite(Date.parse(page.fetchedAt)));
    check(JSON.stringify(page.sourceRevisions) === JSON.stringify([{ source: 'task_queue_projection', revision: page.projectionRevision }]));
  }
  check(page.items.length === want.items.length);
  page.items.forEach((row, index) => {
    const expected = want.items[index];
    check(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...ROW_KEYS].sort()));
    check(row.taskId === expected.taskId && row.projectId === expected.projectId && row.recordedStatus === expected.recordedStatus);
    check(row.archive === expected.archive && row.lifecycle === expected.lifecycle && row.updatedAt === expected.updatedAt);
    check(NULL_KEYS.every(key => row[key] === null) && /^[a-f0-9]{64}$/.test(row.revision));
    check(JSON.stringify(row.reasons) === JSON.stringify(REASONS));
  });
}

const alphaExpected = fixtures => [...fixtures.spec.alpha.tasks.map(row => expectRow(row, 'alpha', false)),
  ...fixtures.spec.alpha.completed.map(row => expectRow(row, 'alpha', true))].sort((a, b) => a.taskId < b.taskId ? -1 : 1);

async function apiControls(deps, fixtures) {
  setConsoleStage('api');
  const { check, fetchPage, request, headers, certs, page, context, sessionCookie } = deps;
  const alpha = alphaExpected(fixtures);
  const projects = await fetchPage(page, '/api/console/v1/projects');
  check(projects.status === 200 && JSON.stringify(projects.json.items) === JSON.stringify(GRANTED));
  check(projects.json.advisor.configuredDefault === true && projects.json.advisor.observation === 'unknown');
  check(projects.json.loop.state === 'unavailable' && projects.json.loop.reason === 'activation_not_verified');
  const capabilities = await fetchPage(page, '/api/capabilities');
  check(capabilities.json.console.state === 'configured' && capabilities.json.console.reason === null);
  check(capabilities.json.mobile.state === 'unavailable' && capabilities.json.mobile.reason === 'loopback_only');
  check(capabilities.json.decision.state === 'unavailable' && capabilities.json.relay.state === 'unavailable' && capabilities.json.ACK.state === 'unavailable');
  mark(deps, 'console-projects-acl');
  // Ungranted, unknown and case-shifted projects are one indistinguishable refusal without counts.
  for (const project of ['beta', 'not-a-project', 'ALPHA']) {
    const refused = await fetchPage(page, `/api/console/v1/tasks?project=${project}`);
    check(refused.status === 403 && refused.body === '{"error":"forbidden"}');
    const detail = await fetchPage(page, `/api/console/v1/tasks/B001?project=${project}`);
    check(detail.status === 403 && detail.body === '{"error":"forbidden"}');
  }
  check((await fetchPage(page, '/api/console/v1/tasks')).status === 403);
  mark(deps, 'console-forbidden');
  const cookie = await sessionCookie(context, page);
  for (const path of ['/api/console/v1/tasks?project=alpha', '/api/console/v1/projects', '/api/console/v1/tasks/A001?project=alpha']) {
    const written = await fetchPage(page, path, { intent: 'write' });
    check(written.status === 405 && written.body === '{"error":"method_refused"}');
    const raw = await request(CONSOLE_PORT, path, { ca: certs.ca, method: 'POST', body: {}, origin: deps.origin, cookie });
    check(raw.status === 405 && raw.headers.allow === 'GET');
  }
  const decisions = await fetchPage(page, '/api/requests', { decision: 'approve' });
  check(decisions.status === 503 && decisions.body === '{"error":"decisions_disabled"}');
  mark(deps, 'console-read-only');
  // The configured Console must not have altered the legacy owner API it shares a service with.
  const legacy = await fetchPage(page, '/api/requests?limit=25');
  check(legacy.status === 200 && legacy.json.items.length === 25 && legacy.json.warnings.length === 0);
  check(legacy.json.items.every(row => row.binding === 'legacy_unbound' && row.task === null && row.purpose === null && row.scope === null));
  const legacyDetail = await fetchPage(page, `/api/requests/${legacy.json.items[0].id}`);
  check(legacyDetail.status === 200 && legacyDetail.json.binding === 'legacy_unbound');
  mark(deps, 'console-legacy-intact');
  const hostile = encodeURIComponent(PAYLOADS[1]);
  for (const query of ['project=alpha&limit=0', 'project=alpha&limit=101', `project=alpha&limit=${hostile}`,
    `project=alpha&status=${hostile}`, 'project=alpha&status=not-a-status', `project=alpha&q=${hostile}`,
    `project=alpha&q=${'x'.repeat(81)}`, 'project=alpha&unknown=1', 'project=alpha&project=beta',
    'project=alpha&limit=25&limit=26', 'project=alpha&view=tasks']) {
    const refused = await fetchPage(page, `/api/console/v1/tasks?${query}`);
    check(refused.status === 400 && refused.body === '{"error":"invalid_query"}');
  }
  // A percent-encoded payload never reaches the reader: the server refuses the path first.
  const encoded = await fetchPage(page, `/api/console/v1/tasks/${hostile}?project=alpha`);
  check(encoded.status === 400 && encoded.body === '{"error":"invalid_request"}');
  check((await fetchPage(page, '/api/console/v1/nope?project=alpha')).status === 404);
  const probe = await context.newPage();
  try {
    const navigated = await probe.goto(`${deps.origin}/api/console/v1/tasks?project=alpha&limit=0`);
    check(navigated.status() === 400 && await navigated.text() === '{"error":"invalid_query"}');
    headers(await navigated.allHeaders(), 'application/json');
    const denied = await probe.goto(`${deps.origin}/api/console/v1/tasks?project=beta`);
    check(denied.status() === 403 && await denied.text() === '{"error":"forbidden"}');
    headers(await denied.allHeaders(), 'application/json');
  } finally { await probe.close(); }
  mark(deps, 'console-query-refusals');
  const first = await fetchPage(page, '/api/console/v1/tasks?project=alpha');
  check(first.status === 200);
  expectPage(deps, first.json, { projectId: 'alpha', coverage: 'complete', warnings: TASK_WARNINGS, total: 30, items: alpha.slice(0, 25), cursor: 'any', revision: 'hash' });
  mark(deps, 'console-coverage-complete');
  const seen = first.json.items.map(row => row.taskId);
  let cursor = first.json.nextCursor, guard = 0;
  while (cursor && guard++ < 10) {
    const next = await fetchPage(page, `/api/console/v1/tasks?project=alpha&cursor=${encodeURIComponent(cursor)}`);
    check(next.status === 200 && next.json.projectionRevision === first.json.projectionRevision && next.json.total === 30);
    for (const row of next.json.items) seen.push(row.taskId);
    cursor = next.json.nextCursor;
  }
  check(JSON.stringify(seen) === JSON.stringify(alpha.map(row => row.taskId)) && new Set(seen).size === 30);
  const small = await fetchPage(page, '/api/console/v1/tasks?project=alpha&limit=7');
  expectPage(deps, small.json, { projectId: 'alpha', coverage: 'complete', warnings: TASK_WARNINGS, total: 30, items: alpha.slice(0, 7), cursor: 'any', revision: 'hash' });
  for (const [query, predicate] of [['status=pending', row => row.recordedStatus === 'pending'],
    ['status=unknown', row => row.recordedStatus === 'unknown'], ['q=A01', row => row.taskId.toLowerCase().includes('a01')],
    ['status=queued&q=A0', row => row.recordedStatus === 'queued' && row.taskId.toLowerCase().includes('a0')]]) {
    const expected = alpha.filter(predicate);
    check(expected.length > 0 && expected.length <= 25);
    const filtered = await fetchPage(page, `/api/console/v1/tasks?project=alpha&${query}`);
    expectPage(deps, filtered.json, { projectId: 'alpha', coverage: 'complete', warnings: TASK_WARNINGS, total: expected.length, items: expected, cursor: null, revision: 'hash' });
  }
  check(alpha.filter(row => row.recordedStatus === 'unknown').length === 2 && alpha.filter(row => row.archive).length === 3);
  const detail = await fetchPage(page, '/api/console/v1/tasks/A001?project=alpha');
  expectPage(deps, detail.json, { projectId: 'alpha', coverage: 'complete', warnings: TASK_WARNINGS, total: 1, cursor: null, revision: 'hash',
    items: [alpha.find(row => row.taskId === 'A001')] });
  const missing = await fetchPage(page, '/api/console/v1/tasks/A999?project=alpha');
  check(missing.status === 404 && missing.body === '{"error":"not_found"}');
  mark(deps, 'console-pagination');
  const issued = first.json.nextCursor, parts = issued.split('.');
  for (const bad of [`${parts[0]}.${'A'.repeat(parts[1].length)}`, 'not-a-cursor', `${issued}x`, 'x'.repeat(1100), parts[0]]) {
    const refused = await fetchPage(page, `/api/console/v1/tasks?project=alpha&cursor=${encodeURIComponent(bad)}`);
    check(refused.status === 400 && refused.json.error === 'invalid_cursor');
  }
  // A cursor binds principal, project, view, filters, page size, detail id, revision and expiry.
  for (const rebound of ['project=alpha&status=pending', 'project=alpha&limit=7', 'project=partialp', 'project=churn']) {
    const refused = await fetchPage(page, `/api/console/v1/tasks?${rebound}&cursor=${encodeURIComponent(issued)}`);
    check(refused.status === 400 && refused.json.error === 'invalid_cursor');
  }
  const crossView = await fetchPage(page, `/api/console/v1/requests?project=alpha&cursor=${encodeURIComponent(issued)}`);
  check(crossView.status === 503 && JSON.stringify(crossView.json.warnings) === JSON.stringify(['requests_contract_unavailable']));
  mark(deps, 'console-cursor-refusals');
  const partialItems = [expectRow(fixtures.spec.partialp.tasks[0], 'partialp', false), expectRow(fixtures.spec.partialp.tasks[1], 'partialp', false)];
  const partial = await fetchPage(page, '/api/console/v1/tasks?project=partialp');
  check(partial.status === 200);
  expectPage(deps, partial.json, { projectId: 'partialp', coverage: 'partial', total: 2, items: partialItems, cursor: null, revision: 'hash',
    warnings: ['conflicting_task_records', 'configured_tasks_missing', ...TASK_WARNINGS] });
  // A conflicted row is omitted, and partial coverage cannot prove a 404.
  for (const id of ['P003', 'P404']) {
    const absent = await fetchPage(page, `/api/console/v1/tasks/${id}?project=partialp`);
    check(absent.status === 503 && absent.body === '{"error":"source_unavailable"}');
  }
  mark(deps, 'console-coverage-partial');
  const broken = await fetchPage(page, '/api/console/v1/tasks?project=broken');
  check(broken.status === 503);
  expectPage(deps, broken.json, { projectId: 'broken', coverage: 'unavailable', total: null, items: [], cursor: null, revision: 'hash',
    warnings: ['task_queue_unavailable', ...TASK_WARNINGS] });
  const brokenDetail = await fetchPage(page, '/api/console/v1/tasks/X001?project=broken');
  check(brokenDetail.status === 503 && brokenDetail.body === '{"error":"source_unavailable"}');
  mark(deps, 'console-coverage-unavailable');
  for (const [view, warning] of [['requests', 'requests_contract_unavailable'], ['releases', 'releases_contract_unavailable'],
    ['approvals', 'legacy_unbound_project_binding_unavailable'], ['evidence', 'evidence_contract_unavailable']]) {
    const response = await fetchPage(page, `/api/console/v1/${view}?project=alpha`);
    check(response.status === 503);
    expectPage(deps, response.json, { projectId: 'alpha', coverage: 'unavailable', warnings: [warning], total: null, items: [], cursor: null, revision: 'null' });
  }
  const evidence = await fetchPage(page, '/api/console/v1/evidence/anything?project=alpha');
  check(evidence.status === 503 && JSON.stringify(evidence.json.warnings) === JSON.stringify(['evidence_contract_unavailable']));
  mark(deps, 'console-views-unavailable');
  return { alpha, issued };
}

/** Nothing outside the projected fields may appear in any response, refusal or rendered page. */
async function leakControls(deps, fixtures) {
  setConsoleStage('leak');
  const { check, fetchPage, page } = deps;
  const forbidden = [...fixtures.secrets, ...PAYLOADS, 'should-never-be-exposed', 'original prompt',
    fixtures.queues.alpha.path, fixtures.dir, fixtures.configPath];
  for (const path of ['/api/console/v1/tasks?project=alpha', '/api/console/v1/tasks?project=alpha&limit=100',
    '/api/console/v1/tasks/A001?project=alpha', '/api/console/v1/tasks?project=partialp',
    '/api/console/v1/tasks?project=broken', '/api/console/v1/tasks?project=beta',
    '/api/console/v1/projects', '/api/capabilities']) {
    const body = (await fetchPage(page, path)).body;
    check(forbidden.every(value => !body.includes(value)));
    // Neither the ungranted project nor its rows may be named by any authorized response.
    check(!body.includes('B001') && !body.includes('beta'));
  }
  const dom = await page.evaluate(() => document.body.innerHTML);
  check(forbidden.every(value => !dom.includes(value)) && !dom.includes('B001'));
  mark(deps, 'console-no-leak');
}

const rowTexts = page => page.$$eval('#requests li button', nodes => nodes.map(node => ({
  title: node.querySelector('strong')?.textContent ?? '', state: node.querySelector('span')?.textContent ?? '',
  observation: node.querySelector('small')?.textContent ?? '' })));
const settled = page => page.waitForFunction(() => !document.querySelector('#refresh').disabled
  && !document.querySelector('#status').textContent.startsWith('Loading'));

/** The step sequence, unchanged: same waits, same checks, same substages, same order. */
async function loginUISteps(deps) {
  setConsoleStage('login-ui');
  const { check, page, cleanDOM, state } = deps;
  setLoginSubstage('navigate');
  await page.goto(deps.origin);
  setLoginSubstage('guest-status');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Sign in with your passkey.');
  setLoginSubstage('guest-visibility');
  check(await page.locator('#workspace').isHidden() && await page.locator('#auth').isVisible());
  setLoginSubstage('credential-ceremony');
  await page.locator('#login').click();
  setLoginSubstage('workspace-rows');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden && document.querySelectorAll('#requests li').length === 25);
  setLoginSubstage('settled');
  await settled(page);
  setLoginSubstage('route-hash');
  check(await page.evaluate(() => location.hash) === '#/projects/alpha/tasks');
  setLoginSubstage('project-options');
  check(JSON.stringify(await page.$$eval('#project option', nodes => nodes.map(node => node.value))) === JSON.stringify(GRANTED));
  setLoginSubstage('chrome-visibility');
  check(await page.locator('#legacy').isHidden() && await page.locator('nav').isVisible());
  setLoginSubstage('filters-visibility');
  check(await page.locator('#filters').isVisible() && await page.locator('#logout').isVisible());
  setLoginSubstage('operation-text');
  check(await page.locator('#operation').textContent() === 'Advisor: default on · Observation unknown · Loop: activation unverified');
  setLoginSubstage('coverage-text');
  const coverage = await page.locator('#coverage').textContent();
  check(coverage.startsWith('Coverage: complete · Source observation: unknown · Source fetched: ') && coverage.endsWith(' · 30 matching recorded tasks'));
  setLoginSubstage('status-text');
  check(await page.locator('#status').textContent() === 'Recorded queue status · Execution and acceptance unknown.');
  setLoginSubstage('status-state');
  check(await page.locator('#status').getAttribute('data-state') === 'ready');
  setLoginSubstage('clean-dom');
  await cleanDOM(page, state);
  setLoginSubstage('mark');
  mark(deps, 'console-login-ui');
}
/** Unchanged behaviour plus one bounded, removable observation. The original rejection is
 *  always rethrown unchanged, the snapshot is taken before the caller's page/context
 *  cleanup, and it is serialized only after that rejection — so neither a failed probe nor
 *  a failed listener can turn a failure into a pass, or a pass into a failure. */
export async function loginUI(deps) {
  try { startLoginObserver(deps.page); } catch { stopLoginObserver(); }
  try {
    await loginUISteps(deps);
  } catch (error) {
    await captureLoginBoundary(deps);
    throw error;
  } finally {
    stopLoginObserver();
  }
}

async function uiControls(deps, alpha) {
  setConsoleStage('ui');
  const { check, page, cleanDOM, state } = deps;
  const rows = await rowTexts(page);
  check(rows.length === 25 && rows.every((row, index) => row.title === `Task ${alpha[index].taskId}`
    && row.state === `${alpha[index].recordedStatus} · execution unknown`
    && row.observation === `Source updated: ${alpha[index].updatedAt || 'unknown'}`));
  // Configured pages replace rather than append, which is what bounds browser memory.
  await page.locator('#more').click();
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 5);
  await settled(page);
  const second = await rowTexts(page);
  check(second.every((row, index) => row.title === `Task ${alpha[25 + index].taskId}`));
  check(await page.locator('#more').isHidden());
  for (const [query, status, predicate] of [['A01', '', row => row.taskId.toLowerCase().includes('a01')],
    ['', 'pending', row => row.recordedStatus === 'pending'], ['', '', () => true]]) {
    await page.locator('#query').fill(query);
    await page.locator('#state').selectOption(status);
    await page.locator('#filters button[type=submit]').click();
    const expected = Math.min(25, alpha.filter(predicate).length);
    await page.waitForFunction(count => document.querySelectorAll('#requests li').length === count, expected);
    await settled(page);
  }
  await cleanDOM(page, state);
  const target = alpha[0];
  await page.locator('#requests li button').first().click();
  await page.waitForFunction(id => !document.querySelector('#detail').hidden && document.querySelector('#fields dd')?.textContent === id, target.taskId);
  await settled(page);
  check(await page.evaluate(() => location.hash) === `#/projects/alpha/tasks/${target.taskId}`);
  const terms = await page.locator('#fields dt').allTextContents(), values = await page.locator('#fields dd').allTextContents();
  check(JSON.stringify(terms) === JSON.stringify(DETAIL_TERMS));
  check(values[1] === 'Redacted summary unavailable' && values[2] === target.recordedStatus);
  check(values[3] === 'No' && values[4] === target.lifecycle && values[5] === target.updatedAt);
  check(UNAVAILABLE_TERMS.every(term => values[DETAIL_TERMS.indexOf(term)] === 'Unknown / unavailable'));
  check(/^[a-f0-9]{64}$/.test(values[14]) && values[15] === REASONS.join(', '));
  check(await page.evaluate(() => document.activeElement?.id) === 'detail-title');
  await page.locator('#back').click();
  await page.waitForFunction(() => document.querySelector('#detail').hidden && document.querySelectorAll('#requests li').length === 25);
  await settled(page);
  check(await page.evaluate(() => (document.activeElement?.textContent ?? '').startsWith('Task A001')
    || document.activeElement?.id === 'refresh'));
  await cleanDOM(page, state);
  mark(deps, 'console-detail');
  for (const [view, expected] of [['requests', 'Unavailable: Request intake and clause mapping unavailable'],
    ['releases', 'Unavailable: Release evidence unavailable'],
    ['approvals', 'Unavailable: Legacy approvals have no verified project binding']]) {
    await page.locator(`nav button[data-view=${view}]`).click();
    await page.waitForFunction(text => document.querySelector('#status').textContent === text, expected);
    await settled(page);
    check(await page.locator('#filters').isHidden() && await page.locator('#requests li').count() === 0);
    check(await page.locator('#coverage').textContent() === 'Coverage: unavailable · Source observation: unknown · Source fetched: unavailable · Count unknown');
    check(await page.locator(`nav button[data-view=${view}]`).getAttribute('aria-pressed') === 'true');
  }
  await page.locator('nav button[data-view=tasks]').click();
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  await settled(page);
  mark(deps, 'console-views-ui');
  await page.locator('#project').selectOption('partialp');
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Partial: '));
  await settled(page);
  check(await page.locator('#status').textContent() === 'Partial: Conflicting task records omitted; Some configured tasks are missing');
  check(await page.locator('#requests li').count() === 2 && await page.locator('#status').getAttribute('data-state') === 'partial');
  await page.locator('#project').selectOption('broken');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Unavailable: Task queue unavailable');
  await settled(page);
  check(await page.locator('#requests li').count() === 0 && await page.locator('#status').getAttribute('data-state') === 'unavailable');
  await page.locator('#project').selectOption('alpha');
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  await settled(page);
  // A copied deep link into an ungranted project erases every private row before reporting.
  await page.evaluate(() => { location.hash = '/projects/beta/tasks'; });
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Forbidden: no access to this project.');
  check(await page.locator('#requests li').count() === 0 && await page.locator('#coverage').textContent() === '');
  check(await page.locator('#detail').isHidden() && await page.locator('#status').getAttribute('data-state') === 'forbidden');
  await page.evaluate(() => { location.hash = '/projects/alpha/tasks'; });
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  await settled(page);
  await cleanDOM(page, state);
  mark(deps, 'console-deep-link');
}

/** A reload really does require signing in again; only then is the deep link restored. */
async function reloadDeepLink(deps, alpha) {
  setConsoleStage('reload-deep-link');
  const { check, page, cleanDOM, state } = deps;
  setConsoleOp('rdl-select-archived');
  const archived = alpha.find(row => row.archive);
  setConsoleOp('rdl-goto');
  // The response object below is produced by the navigation this stage already performs;
  // reading its status adds no request, no wait, no listener and no page interaction. A
  // null response means the browser satisfied the navigation without a document response.
  const navigation = await page.goto(`${deps.origin}/#/projects/alpha/tasks/${archived.taskId}`);
  reloadNav = navigation ? navigation.status() : 0;
  setConsoleOp('rdl-guest-status-wait');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Sign in with your passkey.');
  setConsoleOp('rdl-guest-visibility');
  const workspaceHidden = await page.locator('#workspace').isHidden();
  reloadWorkspaceHidden = workspaceHidden ? 'y' : 'n';
  // The original expression short-circuits, so the row count is queried exactly when it was
  // queried before: this latches state without adding one page operation on either path.
  const guestRows = workspaceHidden ? await page.locator('#requests li').count() : -1;
  reloadGuestRows = guestRows;
  check(workspaceHidden && guestRows === 0);
  setConsoleOp('rdl-guest-hash');
  // Compared in place and discarded on the same line; only the boolean survives.
  const hashMatch = await page.evaluate(() => location.hash) === `#/projects/alpha/tasks/${archived.taskId}`;
  reloadHashMatch = hashMatch ? 'y' : 'n';
  check(hashMatch);
  setConsoleOp('rdl-login-click');
  await page.locator('#login').click();
  setConsoleOp('rdl-detail-wait');
  await page.waitForFunction(id => !document.querySelector('#detail').hidden && document.querySelector('#fields dd')?.textContent === id, archived.taskId);
  setConsoleOp('rdl-settled');
  await settled(page);
  setConsoleOp('rdl-detail-values');
  const values = await page.locator('#fields dd').allTextContents();
  reloadFields = values.length;
  // Three booleans over the same three comparisons; no rendered text is retained or printed.
  const archiveMatch = values[3] === 'Yes; acceptance unknown';
  const lifecycleMatch = values[4] === 'unknown';
  const statusMatch = values[2] === archived.recordedStatus;
  reloadArchiveMatch = archiveMatch ? 'y' : 'n';
  reloadLifecycleMatch = lifecycleMatch ? 'y' : 'n';
  reloadStatusMatch = statusMatch ? 'y' : 'n';
  check(archiveMatch && lifecycleMatch && statusMatch);
  setConsoleOp('rdl-back-click');
  await page.locator('#back').click();
  setConsoleOp('rdl-back-rows-wait');
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  setConsoleOp('rdl-back-settled');
  await settled(page);
  setConsoleOp('rdl-clean-dom');
  await cleanDOM(page, state);
  setConsoleOp('rdl-mark');
  mark(deps, 'console-reload-deep-link');
}

/** One outstanding request per client, observed in the real browser rather than asserted. */
async function singleFlight(deps) {
  setConsoleStage('single-flight');
  const { check, page } = deps;
  const flight = { active: 0, max: 0, total: 0 };
  const isConsole = url => { try { return new URL(url).pathname.startsWith('/api/console/'); } catch { return false; } };
  const opened = request => { if (isConsole(request.url())) { flight.active++; flight.total++; flight.max = Math.max(flight.max, flight.active); } };
  const closed = request => { if (isConsole(request.url())) flight.active--; };
  page.on('request', opened); page.on('requestfinished', closed); page.on('requestfailed', closed);
  try {
    // Real, never-disabled controls: #refresh gates itself, but the view buttons and the filter
    // form call load() unconditionally, so this is a genuine burst rather than a serialized one.
    setConsoleOp('sf-refresh-click');
    await page.locator('#refresh').click();
    setConsoleOp('sf-view-burst');
    for (let i = 0; i < 4; i++) await page.locator('nav button[data-view=tasks]').click();
    setConsoleOp('sf-filters-submit');
    await page.locator('#filters button[type=submit]').click();
    setConsoleOp('sf-view-final');
    await page.locator('nav button[data-view=tasks]').click();
    setConsoleOp('sf-rows-wait');
    await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
    setConsoleOp('sf-settled');
    await settled(page);
    setConsoleOp('sf-flight-check');
    check(flight.total >= 2 && flight.max === 1 && flight.active === 0);
  } finally { page.off('request', opened); page.off('requestfinished', closed); page.off('requestfailed', closed); }
  return flight;
}

/**
 * One bounded window carries two independent observations: a hidden tab must not poll, and a
 * mutated source must expire an outstanding cursor. Visibility comes from a real second tab,
 * not a faked event or an injected clock; the 15 s poll and 15 s snapshot TTL are the product's.
 */
async function lifecycleWindow(deps, fixtures, alphaCursor) {
  setConsoleStage('lifecycle-window');
  const { check, page, context, delay, privateFile, fetchPage } = deps;
  const queue = join(fixtures.dir, 'churn-queue.json'), staged = join(fixtures.dir, 'churn-queue.next');
  const mutated = fixtures.spec.churn.tasks.map((row, index) => index === 2 ? { ...row, status: 'done' } : row);
  setConsoleOp('lw-stage-file');
  await privateFile(staged, JSON.stringify({ tasks: mutated, completed: [] }));
  setConsoleOp('lw-churn-navigate');
  await page.evaluate(() => { location.hash = '/projects/churn/tasks'; });
  setConsoleOp('lw-churn-rows');
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 6);
  setConsoleOp('lw-churn-settled');
  await settled(page);
  setConsoleOp('lw-cursor-before');
  const before = await fetchPage(page, '/api/console/v1/tasks?project=churn&limit=2');
  check(before.status === 200 && typeof before.json.nextCursor === 'string' && before.json.total === 6);
  check(before.json.nextCursor !== alphaCursor);
  // Source owners publish by atomic rename; the reader must notice the new revision.
  setConsoleOp('lw-rename');
  await rename(staged, queue);
  let polls = 0;
  const count = request => { try { if (new URL(request.url()).pathname.startsWith('/api/console/')) polls++; } catch {} };
  setConsoleOp('lw-other-page');
  const other = await context.newPage();
  try {
    await other.bringToFront();
    setConsoleOp('lw-hidden-wait');
    await page.waitForFunction(() => document.hidden === true);
    page.on('request', count);
    setConsoleOp('lw-hidden-window');
    await delay(HIDDEN_WINDOW_MS);
    page.off('request', count);
    setConsoleOp('lw-polls-check');
    check(polls === 0);
    const resumed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/console/v1/tasks', { timeout: 10000 });
    setConsoleOp('lw-resume-front');
    await page.bringToFront();
    setConsoleOp('lw-visible-wait');
    await page.waitForFunction(() => document.hidden === false);
    setConsoleOp('lw-resumed-response');
    await resumed;
    setConsoleOp('lw-resumed-rows');
    await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 6);
    setConsoleOp('lw-resumed-settled');
    await settled(page);
  } finally { await other.close(); }
  mark(deps, 'console-hidden-pause');
  setConsoleOp('lw-cursor-expired');
  const expired = await fetchPage(page, `/api/console/v1/tasks?project=churn&limit=2&cursor=${encodeURIComponent(before.json.nextCursor)}`);
  check(expired.status === 409 && expired.body === '{"error":"cursor_expired"}');
  setConsoleOp('lw-restarted');
  const restarted = await fetchPage(page, '/api/console/v1/tasks?project=churn&limit=2');
  check(restarted.status === 200 && restarted.json.projectionRevision !== before.json.projectionRevision);
  check(restarted.json.items[0].taskId === 'C001' && restarted.json.total === 6);
  setConsoleOp('lw-changed-detail');
  const changed = await fetchPage(page, '/api/console/v1/tasks/C003?project=churn');
  check(changed.json.items[0].recordedStatus === 'done' && changed.json.items[0].lifecycle === 'unknown');
  mark(deps, 'console-cursor-expired');
  setConsoleOp('lw-alpha-return');
  await page.evaluate(() => { location.hash = '/projects/alpha/tasks'; });
  setConsoleOp('lw-alpha-rows');
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  setConsoleOp('lw-alpha-settled');
  await settled(page);
}

const LAYOUT = () => {
  const width = document.documentElement.clientWidth;
  const visible = node => node.getClientRects().length > 0;
  const rect = node => node.getBoundingClientRect();
  const name = node => `${node.tagName}#${node.id || '-'}`;
  const overflowing = [...document.querySelectorAll('main *')].filter(visible)
    .filter(node => { const box = rect(node); return box.right > width + 1 || box.left < -1; }).map(name);
  const overlaps = [];
  for (const selector of ['header', 'nav', '#requests', '.content', '#filters', '.toolbar', '#fields']) {
    for (const container of document.querySelectorAll(selector)) {
      const boxes = [...container.children].filter(visible).map(node => ({ id: `${selector} ${name(node)}`, box: rect(node) }));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box, b = boxes[j].box;
        if (!(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5)) {
          overlaps.push(`${boxes[i].id}|${boxes[j].id}`);
        }
      }
    }
  }
  const small = [...document.querySelectorAll('button, input, select, summary')].filter(visible)
    .filter(node => rect(node).height < 43.5).map(name);
  return { width, scrollWidth: document.documentElement.scrollWidth, bodyScroll: document.body.scrollWidth,
    rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    overflowing: overflowing.slice(0, 6), overlaps: overlaps.slice(0, 6), small: small.slice(0, 6),
    rows: document.querySelectorAll('#requests li').length };
};

function pngSize(deps, buffer) {
  const { check } = deps;
  check(Buffer.isBuffer(buffer) && buffer.length > 1024 && buffer.length <= MAX_PNG);
  check(buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && buffer.subarray(12, 16).toString('ascii') === 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const VIEWPORTS = [['console-320.png', 320, 640, 16], ['console-390.png', 390, 844, 16],
  ['console-768.png', 768, 1024, 16], ['console-1440.png', 1440, 900, 16], ['console-zoom.png', 720, 450, 32]];

/**
 * Browser emulation at CSS widths, on the post-login synthetic Tasks view. This is NOT physical
 * Fold7, remote-phone or real-network acceptance, and the zoom frame is not a browser-zoom API:
 * Chromium exposes none to Playwright or CDP here, so it is a halved CSS viewport plus 200% root
 * text, labelled as exactly that in the receipt.
 */
async function responsive(deps, fixtures, artifacts) {
  setConsoleStage('responsive');
  const { check, page, cleanDOM, state, privateFile } = deps;
  const screenshots = {};
  for (const [name, width, height, rootFontPx] of VIEWPORTS) {
    setConsoleOp('rv-viewport');
    await page.setViewportSize({ width, height });
    setConsoleOp('rv-root-font');
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootFontPx);
    setConsoleOp('rv-rows-wait');
    await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25 && !document.querySelector('#refresh').disabled);
    setConsoleOp('rv-layout');
    const layout = await page.evaluate(LAYOUT);
    check(layout.width === width && layout.rows === 25 && layout.rootFontPx === rootFontPx);
    check(layout.scrollWidth <= width + 1 && layout.bodyScroll <= width + 1);
    check(layout.overflowing.length === 0 && layout.overlaps.length === 0 && layout.small.length === 0);
    setConsoleOp('rv-clean-dom');
    await cleanDOM(page, state);
    setConsoleOp('rv-text-leak');
    const text = await page.evaluate(() => document.body.innerText);
    check([...fixtures.secrets, ...PAYLOADS].every(value => !text.includes(value)));
    setConsoleOp('rv-screenshot');
    const buffer = await page.screenshot({ fullPage: false, type: 'png', animations: 'disabled', caret: 'hide' });
    setConsoleOp('rv-png-size');
    const size = pngSize(deps, buffer);
    check(size.width === width && size.height === height);
    setConsoleOp('rv-secret-scan');
    check(fixtures.secrets.every(secret => !buffer.includes(Buffer.from(secret, 'utf8'))));
    setConsoleOp('rv-write');
    await privateFile(join(artifacts.dir, name), buffer);
    screenshots[name] = { sha256: digest(buffer), bytes: buffer.length, cssWidth: width, cssHeight: height, rootFontPx,
      mode: name === 'console-zoom.png' ? 'text_scale_200_percent_and_halved_css_viewport' : 'css_viewport' };
  }
  setConsoleOp('rv-reset');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 1280, height: 800 });
  setConsoleOp('rv-names');
  check(JSON.stringify(Object.keys(screenshots)) === JSON.stringify(SCREENSHOTS));
  setConsoleOp('rv-mark');
  mark(deps, 'console-responsive');
  return screenshots;
}

/** Sign-out and an expired session must erase every private row before they report anything. */
async function stateCleared(deps) {
  setConsoleStage('state-cleared');
  const { check, page, fetchPage, cleanDOM, state } = deps;
  setConsoleOp('sc-open-detail');
  await page.locator('#requests li button').first().click();
  setConsoleOp('sc-detail-wait');
  await page.waitForFunction(() => !document.querySelector('#detail').hidden);
  setConsoleOp('sc-settled');
  await settled(page);
  setConsoleOp('sc-logout-click');
  await page.locator('#logout').click();
  setConsoleOp('sc-signed-out-wait');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Signed out.');
  setConsoleOp('sc-workspace-hidden');
  check(await page.locator('#workspace').isHidden() && await page.locator('#auth').isVisible());
  setConsoleOp('sc-rows-cleared');
  check(await page.locator('#requests li').count() === 0 && await page.locator('#detail').isHidden());
  setConsoleOp('sc-fields-cleared');
  check(await page.locator('#fields dd').count() === 0 && await page.locator('#coverage').textContent() === '');
  setConsoleOp('sc-logout-hidden');
  check(await page.locator('#logout').isHidden());
  setConsoleOp('sc-revoked-tasks');
  const revoked = await fetchPage(page, '/api/console/v1/tasks?project=alpha');
  check(revoked.status === 401 && revoked.body === '{"error":"authentication_required"}');
  setConsoleOp('sc-revoked-projects');
  check((await fetchPage(page, '/api/console/v1/projects')).status === 401);
  setConsoleOp('sc-clean-dom');
  await cleanDOM(page, state);
  setConsoleOp('sc-mark');
  mark(deps, 'console-state-cleared');
}

async function artifactInventory(deps, artifacts, withReceipt) {
  const { check } = deps;
  const names = (await readdir(artifacts.dir)).sort();
  check(JSON.stringify(names) === JSON.stringify((withReceipt ? [...SCREENSHOTS, CONSOLE_RECEIPT] : [...SCREENSHOTS]).sort()));
  let total = 0;
  for (const name of names) {
    const stat = await lstat(join(artifacts.dir, name));
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    check(stat.size > 0 && stat.size <= (name === CONSOLE_RECEIPT ? MAX_RECEIPT : MAX_PNG));
    total += stat.size;
  }
  check(total <= MAX_ARTIFACTS);
  return names;
}

const RECEIPT_KEYS = ['schemaVersion', 'status', 'skipped', 'started', 'finished', 'candidate', 'source', 'product',
  'tests', 'runtime', 'browser', 'console', 'controls', 'screenshots', 'evidenceDigest'];

/** The whole configured-Console phase. The caller owns the service, browser and cleanup. */
export async function consoleAcceptance(deps) {
  const { fixtures, artifacts, binding } = deps;
  await loginUI(deps);
  const { alpha, issued } = await apiControls(deps, fixtures);
  await leakControls(deps, fixtures);
  await uiControls(deps, alpha);
  await reloadDeepLink(deps, alpha);
  const flight = await singleFlight(deps);
  await lifecycleWindow(deps, fixtures, issued);
  await deps.cleanDOM(deps.page, deps.state);
  mark(deps, 'console-inert-markup');
  mark(deps, 'console-single-flight');
  const screenshots = await responsive(deps, fixtures, artifacts);
  await stateCleared(deps);
  setConsoleStage('artifacts');
  // The artifact control is earned before the receipt is built, because the receipt must already
  // record every control as a pass. At this point the owned directory must hold exactly the five
  // emitted screenshots and nothing else; the receipt itself is re-verified below.
  await artifactInventory(deps, artifacts, false);
  mark(deps, 'console-artifacts');
  setConsoleStage('receipt');
  const receipt = {
    schemaVersion: 1, status: 'pass', skipped: 0, started: binding.started, finished: new Date().toISOString(),
    candidate: binding.candidate, source: binding.source, product: binding.product, tests: binding.tests,
    runtime: binding.runtime, browser: binding.browser,
    console: { port: CONSOLE_PORT, origin: `https://localhost:${CONSOLE_PORT}`, principal: 'inbox-owner',
      configDigest: fixtures.configDigest, configuredProjects: [...CONFIGURED], grantedProjects: [...GRANTED],
      queueDigests: Object.fromEntries(Object.entries(fixtures.queues).map(([id, value]) => [id, value.digest])),
      maxConcurrentClientRequests: flight.max, hiddenWindowMs: HIDDEN_WINDOW_MS,
      surface: 'browser_emulation_only', device: 'unavailable', proxy: 'unavailable', mobileNetwork: 'unavailable' },
    controls: Object.fromEntries(CONSOLE_IDS.map(id => [id, outcomes.get(id) ?? 'missing'])),
    screenshots, evidenceDigest: '',
  };
  receipt.evidenceDigest = digest(JSON.stringify({ controls: receipt.controls, screenshots: receipt.screenshots, console: receipt.console }));
  await validateConsoleReceipt(deps, receipt, artifacts);
  await deps.privateFile(artifacts.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  // Nothing below can turn an unverified artifact set into a pass: both of these throw.
  const names = await artifactInventory(deps, artifacts, true);
  const bytes = await readFile(artifacts.receipt);
  const written = JSON.parse(bytes.toString('utf8'));
  await validateConsoleReceipt(deps, written, artifacts);
  deps.check(written.evidenceDigest === receipt.evidenceDigest && written.controls['console-artifacts'] === 'pass');
  return { receipt: digest(bytes), artifacts: names, evidenceDigest: receipt.evidenceDigest };
}

/** Strict, mechanical validation. A missing or unavailable check can never read as a pass. */
export async function validateConsoleReceipt(deps, receipt, artifacts) {
  const { check, exactKeys, identity, toolHashes, fileHash, chromium, VERSION } = deps;
  exactKeys(receipt, RECEIPT_KEYS);
  check(receipt.schemaVersion === 1 && receipt.status === 'pass' && receipt.skipped === 0);
  check(Number.isFinite(Date.parse(receipt.started)) && Date.parse(receipt.finished) >= Date.parse(receipt.started));
  check(Date.parse(receipt.finished) - Date.parse(receipt.started) < 600000);
  check(receipt.candidate === process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(receipt.candidate));
  const hashes = await identity();
  exactKeys(receipt.source, ['source', 'lock', 'manifest', 'contract']);
  check(['source', 'lock', 'manifest', 'contract'].every(key => receipt.source[key] === hashes[key]));
  exactKeys(receipt.product, ['compiled', 'cli']);
  check(receipt.product.compiled === hashes.compiled && receipt.product.cli === hashes.cli);
  exactKeys(receipt.tests, ['browserTlsCaller', 'consoleCaller']);
  check(receipt.tests.browserTlsCaller === hashes.caller && receipt.tests.consoleCaller === hashes.consoleCaller);
  check(receipt.tests.consoleCaller === await fileHash(consoleCallerPath));
  exactKeys(receipt.runtime, ['node', 'hashes', 'image', 'imageVersion', 'run', 'attempt', 'job']);
  check(receipt.runtime.node === process.version && receipt.runtime.node.startsWith('v20.') && receipt.runtime.job === 'browser-tls');
  check(receipt.runtime.run === process.env.GITHUB_RUN_ID && receipt.runtime.attempt === process.env.GITHUB_RUN_ATTEMPT);
  check(receipt.runtime.image === process.env.ImageOS && receipt.runtime.imageVersion === process.env.ImageVersion);
  const tools = await toolHashes();
  exactKeys(receipt.runtime.hashes, Object.keys(tools));
  check(Object.entries(tools).every(([key, value]) => receipt.runtime.hashes[key] === value));
  exactKeys(receipt.browser, ['playwright', 'version', 'revision', 'executableHash']);
  check(receipt.browser.playwright === '1.58.2' && receipt.browser.version === VERSION && receipt.browser.revision === '1208');
  check(receipt.browser.executableHash === await fileHash(chromium.executablePath()));
  exactKeys(receipt.console, ['port', 'origin', 'principal', 'configDigest', 'configuredProjects', 'grantedProjects',
    'queueDigests', 'maxConcurrentClientRequests', 'hiddenWindowMs', 'surface', 'device', 'proxy', 'mobileNetwork']);
  check(receipt.console.port === CONSOLE_PORT && receipt.console.origin === `https://localhost:${CONSOLE_PORT}`);
  check(receipt.console.principal === 'inbox-owner' && receipt.console.surface === 'browser_emulation_only');
  check(receipt.console.device === 'unavailable' && receipt.console.proxy === 'unavailable' && receipt.console.mobileNetwork === 'unavailable');
  check(receipt.console.maxConcurrentClientRequests === 1 && receipt.console.hiddenWindowMs === HIDDEN_WINDOW_MS);
  check(/^[a-f0-9]{64}$/.test(receipt.console.configDigest));
  check(JSON.stringify(receipt.console.configuredProjects) === JSON.stringify(CONFIGURED));
  check(JSON.stringify(receipt.console.grantedProjects) === JSON.stringify(GRANTED));
  exactKeys(receipt.console.queueDigests, ['alpha', 'partialp', 'churn', 'beta']);
  check(Object.values(receipt.console.queueDigests).every(value => /^[a-f0-9]{64}$/.test(value)));
  exactKeys(receipt.controls, CONSOLE_IDS);
  check(CONSOLE_IDS.every(id => receipt.controls[id] === 'pass'));
  exactKeys(receipt.screenshots, SCREENSHOTS);
  for (const [name, width, height, rootFontPx] of VIEWPORTS) {
    const shot = receipt.screenshots[name];
    exactKeys(shot, ['sha256', 'bytes', 'cssWidth', 'cssHeight', 'rootFontPx', 'mode']);
    check(shot.cssWidth === width && shot.cssHeight === height && shot.rootFontPx === rootFontPx);
    check(shot.mode === (name === 'console-zoom.png' ? 'text_scale_200_percent_and_halved_css_viewport' : 'css_viewport'));
    check(/^[a-f0-9]{64}$/.test(shot.sha256) && Number.isInteger(shot.bytes) && shot.bytes > 1024 && shot.bytes <= MAX_PNG);
    const buffer = await readFile(join(artifacts.dir, name));
    check(buffer.length === shot.bytes && digest(buffer) === shot.sha256);
    const size = pngSize(deps, buffer);
    check(size.width === width && size.height === height);
  }
  check(new Set(SCREENSHOTS.map(name => receipt.screenshots[name].sha256)).size === SCREENSHOTS.length);
  check(receipt.evidenceDigest === digest(JSON.stringify({ controls: receipt.controls, screenshots: receipt.screenshots, console: receipt.console })));
}

/** Re-validates the emitted artifact set from disk for the caller's --validate-receipt pass. */
export async function validateConsoleArtifacts(deps, expected) {
  const { check } = deps;
  const dir = artifactsDir(process.env.RUNNER_TEMP);
  check(process.env.CONSOLE_UI_ARTIFACTS === dir);
  const stat = await lstat(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink());
  const artifacts = { dir, receipt: join(dir, CONSOLE_RECEIPT) };
  const names = await artifactInventory(deps, artifacts, true);
  check(JSON.stringify(names) === JSON.stringify([...expected.artifacts]));
  const bytes = await readFile(artifacts.receipt);
  check(digest(bytes) === expected.receipt);
  const receipt = JSON.parse(bytes.toString('utf8'));
  await validateConsoleReceipt(deps, receipt, artifacts);
  check(receipt.evidenceDigest === expected.evidenceDigest);
}
