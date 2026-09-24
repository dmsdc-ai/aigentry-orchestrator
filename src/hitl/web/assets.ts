export const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task Console</title><link rel="stylesheet" href="/assets/inbox.css"><script src="/assets/inbox.js" defer></script></head>
<body><main><header><h1>Task Console</h1><span>Read only</span><button id="logout" hidden>Sign out</button></header>
<p id="status" role="status" aria-live="polite">Loading availability…</p>
<section id="auth" aria-label="Sign in"><button id="login">Sign in with passkey</button><details><summary>Enroll owner</summary><label for="invitation">Single-use invitation</label><input id="invitation" type="password" autocomplete="off" maxlength="128"><button id="enroll">Create passkey</button></details></section>
<section id="workspace" hidden aria-label="Console workspace">
<div class="toolbar"><label for="project">Project</label><select id="project"></select><button id="refresh" aria-label="Refresh current view">↻ Refresh</button></div>
<nav aria-label="Console views"><button data-view="tasks" aria-pressed="true">☷ Tasks</button><button data-view="requests" aria-pressed="false">▤ Request Inbox</button><button data-view="releases" aria-pressed="false">◇ Releases</button><button data-view="approvals" aria-pressed="false">✓ Approvals</button></nav>
<p id="operation">Advisor: default on · Observation unknown · Loop: activation unverified</p>
<form id="filters" class="toolbar"><label for="query">Task ID</label><input id="query" maxlength="80" pattern="[A-Za-z0-9_-]*" type="search"><label for="state">Recorded status</label><select id="state"><option value="">All</option><option>pending</option><option>queued</option><option>delegated</option><option>in_progress</option><option>blocked</option><option>blocked-by-observation</option><option>done</option><option>completed</option><option>failed</option><option>cancelled</option><option>superseded</option><option>unknown</option></select><button type="submit">Apply</button></form>
<div id="legacy" hidden><p>Legacy approvals · Unbound to project, task, and attempt · Decisions disabled</p><button id="pending" aria-pressed="true">Pending</button><button id="history" aria-pressed="false">History</button></div>
<p id="coverage"></p><div class="content"><section aria-label="Records"><ul id="requests" aria-label="Records"></ul><button id="more" hidden>Next page</button></section>
<section id="detail" aria-label="Record details" hidden><button id="back">← Back to list</button><h2 tabindex="-1" id="detail-title">Details</h2><dl id="fields"></dl></section></div>
</section></main></body></html>`;

export const css = `:root{font-family:system-ui,sans-serif;color:#242a30;background:#f7f8fa;font-size:16px}*{box-sizing:border-box;min-width:0}body{margin:0}main{max-width:1440px;margin:auto;padding:20px}header{display:flex;align-items:center;flex-wrap:wrap;gap:16px;border-bottom:1px solid #ccd2d9;padding-bottom:12px}h1{font-size:1.25rem;margin:0}h2{font-size:1.1rem}header span,#operation,#coverage{color:#535d68;font-size:.875rem}header button{margin-left:auto}p,dd,li,button,summary{overflow-wrap:anywhere}button,input,select,summary{font:inherit;min-height:44px;max-width:100%}button,input,select{border:1px solid #89939f;border-radius:4px;padding:8px 12px;background:#fff;color:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.65}button[aria-pressed=true]{background:#e7edf9;border-color:#365c9d;color:#183a70}button:hover{background:#edf1f6}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #365c9d;outline-offset:3px}nav,.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:16px 0}nav{border-bottom:1px solid #ccd2d9;padding-bottom:12px}label{font-weight:600;font-size:.875rem}input{width:12rem}select{width:14rem}#auth{padding:12px 0}#auth details{margin-top:12px}summary{cursor:pointer;padding:10px 0}#auth label{display:block}#status{padding:12px;border-left:3px solid #8b681a;background:#fcf5e5}#status[data-state=forbidden],#status[data-state=error]{border-color:#a93636;background:#fbeeee}#status[data-state=ready]{border-color:#3c7055;background:#edf5ef}.content{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}ul{padding:0;list-style:none;margin:0}li{border-bottom:1px solid #ccd2d9}li button{border:0;border-radius:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);width:100%;gap:12px;text-align:left;padding:14px 8px;background:transparent}li strong{font-weight:600}li small{color:#535d68}#detail{border-top:1px solid #ccd2d9;padding-top:12px}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px}dt{font-weight:600;overflow-wrap:anywhere}dd{margin:0;white-space:pre-wrap}#more{margin-top:16px}[hidden]{display:none!important}@media(min-width:1100px){.content:has(#detail:not([hidden])){grid-template-columns:minmax(0,3fr) minmax(0,2fr)}#detail{border-top:0;border-left:1px solid #ccd2d9;padding:0 0 0 20px}}@media(max-width:600px){main{padding:12px}nav button{flex:1 1 9rem}.toolbar{align-items:stretch}.toolbar label{flex-basis:100%}.toolbar input,.toolbar select{width:100%}li button{grid-template-columns:minmax(0,1fr)}dl{grid-template-columns:minmax(0,1fr);gap:6px}dd{margin-bottom:10px}header{gap:8px}}`;

export const js = String.raw`'use strict';
const el = id => document.getElementById(id);
let busy = false, queued = false, timer = null, failures = 0, next = null, pageCursor = null, csrf = null;
let configured = false, legacyView = 'pending', loggedIn = false, capability = null;
let lastFetch = null, previousRoute = '', focusDetail = false, retryDelay = null, lastSelected = null, restoreFocus = false;
function status(message, state) { el('status').textContent = message; el('status').dataset.state = state; }
function clearPrivate() { el('requests').replaceChildren(); el('fields').replaceChildren(); el('detail').hidden = true; el('coverage').textContent = ''; el('more').hidden = true; next = null; pageCursor = null; lastFetch = null; }
function route() {
  const match = /^#\/projects\/([A-Za-z0-9_-]+)\/(tasks|requests|releases|approvals)(?:\/([A-Za-z0-9_-]+))?$/.exec(location.hash);
  return match ? { project: match[1], view: match[2], id: match[3] || null } : { project: el('project').value, view: 'tasks', id: null };
}
function navigate(view, id) {
  if (configured) location.hash = '/projects/' + el('project').value + '/' + view + (id ? '/' + id : '');
  else load(false, id);
}
async function request(path, body) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
    if (body !== undefined && csrf) headers['x-inbox-csrf'] = csrf;
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
    const data = await response.json();
    if (!response.ok && !(response.status === 503 && data.schemaVersion === 1)) {
      const error = new Error(response.status === 401 ? 'Sign in required.' : response.status === 403 ? 'Forbidden: no access to this project.' : response.status === 409 ? 'Snapshot expired. Refresh to restart pagination.' : response.status === 429 ? 'Busy. Retrying shortly.' : 'Source or service unavailable.');
      error.code = response.status;
      error.retry = Math.min(60, Math.max(15, Number(response.headers.get('Retry-After')) || 15));
      throw error;
    }
    return data;
  } finally { clearTimeout(timeout); }
}
function field(name, value) {
  const term = document.createElement('dt'), description = document.createElement('dd');
  term.textContent = name;
  description.textContent = value === null || value === undefined || value === '' ? 'Unknown / unavailable' : String(value);
  el('fields').append(term, description);
}
function renderDetail(row, legacy) {
  el('fields').replaceChildren();
  if (legacy) {
    // Legacy field order and positions are part of the approval-inbox contract.
    for (const [name, value] of [['Request', row.id], ['Question', row.question], ['Worker', row.subjectSid], ['Task', row.task], ['Purpose', row.purpose], ['Scope', row.scope], ['State', row.state], ['Created', row.createdAt], ['Decision', row.decision], ['Binding', row.binding], ['Decisions', 'Disabled']]) field(name, value);
  } else {
    for (const [name, value] of [['Task', row.taskId], ['Title', 'Redacted summary unavailable'], ['Recorded status', row.recordedStatus], ['Archive membership', row.archive ? 'Yes; acceptance unknown' : 'No'], ['Lifecycle evidence', row.lifecycle], ['Source updated', row.updatedAt], ['Execution observed', row.observedAt], ['Phase', row.phase], ['SID / attempt / operation', null], ['Requested model / effort', null], ['Observed model / effort', null], ['Blocker / resume owner', null], ['Release / acceptance', null], ['Obligations / artifacts', null], ['Revision', row.revision], ['Coverage reasons', row.reasons.join(', ')]]) field(name, value);
  }
  el('detail').hidden = false;
  if (focusDetail) { el('detail-title').focus(); focusDetail = false; }
}
function renderRows(data, legacy, current, append) {
  if (!append) el('requests').replaceChildren();
  for (const row of data.items) {
    const li = document.createElement('li'), button = document.createElement('button');
    if (legacy) button.textContent = row.id + ' — ' + row.question;
    else {
      const title = document.createElement('strong'), state = document.createElement('span'), observation = document.createElement('small');
      title.textContent = 'Task ' + row.taskId;
      state.textContent = row.recordedStatus + ' · execution unknown';
      observation.textContent = 'Source updated: ' + (row.updatedAt || 'unknown');
      button.append(title, state, observation);
    }
    button.addEventListener('click', () => { focusDetail = true; lastSelected = legacy ? row.id : row.taskId; navigate(current.view, lastSelected); });
    li.append(button); el('requests').append(li);
    if (restoreFocus && lastSelected === (legacy ? row.id : row.taskId)) button.focus();
  }
  if (restoreFocus && document.activeElement === document.body) el('refresh').focus();
  restoreFocus = false;
  next = data.nextCursor; el('more').hidden = !next;
}
function schedule() {
  clearTimeout(timer);
  // Legacy approvals never polled in the background; keep that list stable.
  if (document.hidden || !loggedIn || !configured) return;
  const seconds = Math.max(retryDelay || 0, Math.min(60, 15 * Math.pow(2, failures)));
  timer = setTimeout(() => load(), seconds * 1000 + Math.random() * 1500);
}
function showFailure(error) {
  failures = Math.min(failures + 1, 2); retryDelay = error.retry || null;
  if (error.code === 401 || error.code === 403) {
    clearPrivate();
    if (error.code === 401) { loggedIn = false; el('workspace').hidden = true; el('auth').hidden = false; el('logout').hidden = true; }
    status(error.message, error.code === 403 ? 'forbidden' : 'authentication');
  } else if (error.code === 409) { next = null; pageCursor = null; el('more').hidden = true; status(error.message, 'stale'); }
  else if (!error.code) status((navigator.onLine ? 'Connection error' : 'Offline') + (lastFetch ? ' · Stale view fetched ' + lastFetch : '') + '. Retry available.', navigator.onLine ? 'error' : 'offline');
  else status(error.message + (lastFetch ? ' Stale view fetched ' + lastFetch + '.' : ''), 'error');
}
async function load(more = false, legacyId = null) {
  if (busy) { queued = true; return; }
  if (document.hidden || !loggedIn) return;
  busy = true; clearTimeout(timer); el('refresh').disabled = true; el('more').disabled = true;
  const current = route(), token = location.hash;
  const scope = current.project + '/' + current.view;
  if (previousRoute !== scope) { clearPrivate(); previousRoute = scope; }
  status(lastFetch ? 'Loading · Previous view fetched ' + lastFetch : 'Loading…', 'loading');
  try {
    const legacy = !configured;
    if (!legacy && !Array.from(el('project').options).some(option => option.value === current.project)) { const error = new Error('Forbidden: no access to this project.'); error.code = 403; throw error; }
    if (!legacy) el('project').value = current.project;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === current.view));
    el('filters').hidden = legacy || current.view !== 'tasks';
    const params = new URLSearchParams(legacy ? { view: legacyView, limit: '25' } : { project: current.project, limit: '25', status: el('state').value, q: el('query').value });
    // Legacy pagination is cumulative from the live cursor; configured views page in place.
    const requestedCursor = more ? next : legacy ? null : pageCursor;
    if (requestedCursor) params.set('cursor', requestedCursor);
    const id = legacy ? legacyId : current.id;
    if (id) { params.delete('limit'); params.delete('cursor'); params.delete('status'); params.delete('q'); }
    const path = legacy ? '/api/requests' : '/api/console/v1/' + current.view;
    const data = await request(path + (id ? '/' + encodeURIComponent(id) : '') + '?' + params.toString());
    if (token !== location.hash || queued) { queued = true; return; }
    failures = 0; retryDelay = null; lastFetch = data.fetchedAt || new Date().toISOString();
    if (id && (legacy || data.items.length)) renderDetail(legacy ? data : data.items[0], legacy);
    else { pageCursor = requestedCursor; const append = legacy && more; renderRows(data, legacy, current, append); if (!append) el('detail').hidden = true; }
    if (legacy) {
      el('coverage').textContent = 'Legacy approvals only · Project coverage unavailable';
      status(data.warnings && data.warnings.length ? 'Partial: some approval records unavailable.' : 'Read-only legacy approvals · Decisions disabled.', data.warnings && data.warnings.length ? 'partial' : 'ready');
    } else {
      el('coverage').textContent = 'Coverage: ' + data.coverage + ' · Source observation: unknown · Source fetched: ' + (data.fetchedAt || 'unavailable') + (data.total === null ? ' · Count unknown' : ' · ' + data.total + ' matching recorded tasks');
      const reasons = { task_queue_unavailable: 'Task queue unavailable', requests_contract_unavailable: 'Request intake and clause mapping unavailable', releases_contract_unavailable: 'Release evidence unavailable', legacy_unbound_project_binding_unavailable: 'Legacy approvals have no verified project binding', configured_tasks_missing: 'Some configured tasks are missing', conflicting_task_records: 'Conflicting task records omitted' };
      const warnings = data.warnings.filter(reason => reasons[reason]).map(reason => reasons[reason]);
      status(data.coverage === 'unavailable' ? 'Unavailable: ' + warnings.join('; ') : data.coverage === 'partial' ? 'Partial: ' + warnings.join('; ') : data.items.length ? 'Recorded queue status · Execution and acceptance unknown.' : 'No matching tasks in the complete configured queue scope.', data.coverage === 'complete' ? 'ready' : data.coverage);
    }
  } catch (error) { showFailure(error); }
  finally {
    busy = false; el('refresh').disabled = false; el('more').disabled = false;
    if (queued) { queued = false; void load(); } else schedule();
  }
}
async function openWorkspace() {
  clearPrivate();
  configured = capability.console && capability.console.state === 'configured';
  if (configured) {
    const data = await request('/api/console/v1/projects');
    el('project').replaceChildren();
    for (const project of data.items) { const option = document.createElement('option'); option.value = project; option.textContent = project; el('project').append(option); }
    if (!data.items.length) { const error = new Error('Forbidden: no project grants configured.'); error.code = 403; throw error; }
  } else await request('/api/requests?limit=1');
  loggedIn = true; el('auth').hidden = true; el('workspace').hidden = false;
  el('project').hidden = !configured; document.querySelector('label[for=project]').hidden = !configured;
  document.querySelector('nav').hidden = !configured; el('operation').hidden = !configured; el('legacy').hidden = configured;
  if (configured && !location.hash) location.hash = '/projects/' + el('project').value + '/tasks';
}
function decode(value) { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
function encode(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function authenticate(enroll) {
  if (busy) return;
  busy = true; clearTimeout(timer); clearPrivate(); status(enroll ? 'Creating passkey…' : 'Signing in…', 'loading');
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('Passkeys unavailable');
    const preauth = await request('/auth/preauth', {}); csrf = preauth.csrf;
    const invitation = el('invitation').value; el('invitation').value = '';
    const action = enroll ? 'enroll' : 'login';
    const result = await request('/auth/' + action + '/options', enroll ? { invitation } : {});
    const options = result.options; options.challenge = decode(options.challenge);
    if (options.user) options.user.id = decode(options.user.id);
    for (const name of ['allowCredentials', 'excludeCredentials']) if (options[name]) options[name] = options[name].map(item => ({ ...item, id: decode(item.id) }));
    const credential = enroll ? await navigator.credentials.create({ publicKey: options }) : await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('Passkey cancelled');
    const response = { clientDataJSON: encode(credential.response.clientDataJSON) };
    if (enroll) { response.attestationObject = encode(credential.response.attestationObject); if (credential.response.getTransports) response.transports = credential.response.getTransports(); }
    else { response.authenticatorData = encode(credential.response.authenticatorData); response.signature = encode(credential.response.signature); response.userHandle = credential.response.userHandle ? encode(credential.response.userHandle) : null; }
    const verified = await request('/auth/' + action + '/verify', { response: { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment } });
    csrf = verified.csrf; el('logout').hidden = false;
    capability = await request('/api/capabilities'); await openWorkspace();
  } catch (error) { if (error.code) showFailure(error); else status('Sign-in or enrollment failed. Retry with a supported passkey and valid invitation.', 'error'); }
  finally { busy = false; queued = false; if (loggedIn) load(); }
}
el('login').addEventListener('click', () => authenticate(false));
el('enroll').addEventListener('click', () => authenticate(true));
el('logout').addEventListener('click', async () => {
  if (busy) return;
  busy = true; clearTimeout(timer); clearPrivate();
  try { await request('/auth/logout', {}); csrf = null; loggedIn = false; el('workspace').hidden = true; el('auth').hidden = false; el('logout').hidden = true; status('Signed out.', 'authentication'); }
  catch (error) { showFailure(error); }
  finally { busy = false; schedule(); }
});
el('refresh').addEventListener('click', () => load());
el('more').addEventListener('click', () => load(true));
el('project').addEventListener('change', () => { const current = route(); clearPrivate(); navigate(current.view); });
el('filters').addEventListener('submit', event => { event.preventDefault(); clearPrivate(); const current = route(); if (current.id) navigate('tasks'); else load(); });
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { clearPrivate(); if (route().view === button.dataset.view && !route().id) load(); else navigate(button.dataset.view); });
for (const name of ['pending', 'history']) el(name).addEventListener('click', () => { legacyView = name; for (const view of ['pending', 'history']) el(view).setAttribute('aria-pressed', String(view === name)); clearPrivate(); load(); });
el('back').addEventListener('click', () => { restoreFocus = true; const current = route(); if (configured) navigate(current.view); else { el('detail').hidden = true; load(); } });
window.addEventListener('hashchange', () => { const current = route(); if (current.project + '/' + current.view !== previousRoute) clearPrivate(); if (!current.id) restoreFocus = true; load(); });
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) load(); });
window.addEventListener('online', () => load());
async function init() {
  busy = true;
  try {
    capability = await request('/api/capabilities');
    configured = !!(capability.console && capability.console.state === 'configured');
    if (capability.auth.state === 'dependency_unverified') { status('Authentication dependency unavailable.', 'unavailable'); return; }
    if (capability.auth.state !== 'ready') {
      status(configured ? 'Setup required: trusted localhost TLS and owner enrollment.'
        : 'Setup unavailable: ' + capability.auth.reason + '. A verified authentication adapter and trusted localhost TLS are required.', 'unavailable');
      return;
    }
    status('Sign in with your passkey.', 'authentication');
    // Legacy approvals reopen straight from an existing session, as before the Console.
    if (!configured) await openWorkspace();
  } catch (error) { showFailure(error); }
  finally { busy = false; queued = false; if (loggedIn) load(); }
}
void init();`;
