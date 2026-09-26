import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdvisorError, requireV2 } from './contracts.js';
import { AdvisorStore, canonicalWorkspace, commandResult, type CommandResult, type Workspace } from './store.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
export interface HostFence { token: string; generation: number }

/** One owned child, capped combined output and total lifetime; await close after
 * killing only that child. No process scan, shell, provider or descendant work. */
export async function boundedTick(workspace: Workspace, trigger: 'manual' | 'host', fence: HostFence | null = null, releaseId?: string): Promise<{ exit: number; result: CommandResult }> {
  const args = ['--max-old-space-size=64', CLI, 'tick', '--workspace', workspace.path, '--trigger', trigger, '--internal-tick', '--json'];
  if (fence) args.push('--host-token', fence.token, '--host-generation', String(fence.generation));
  if (releaseId !== undefined) args.push('--release-id', releaseId);
  return boundedAdvisorChild(args);
}
export async function boundedMeasure(workspace: Workspace, limitsFile: string, releaseId?: string): Promise<{ exit: number; result: CommandResult }> {
  const args = ['--max-old-space-size=64', CLI, 'measure', '--workspace', workspace.path, '--limits-file', limitsFile, '--internal-measure', '--json'];
  if (releaseId !== undefined) args.push('--release-id', releaseId);
  return boundedAdvisorChild(args);
}
function boundedAdvisorChild(args: string[]): Promise<{ exit: number; result: CommandResult }> {
  const label = args[2] === 'measure' ? 'measurement' : 'tick';
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: cleanNodeEnvironment() });
    let total = 0, output = '', failure: string | null = null, settled = false;
    const terminate = (reason: string): void => { failure = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => terminate(label + '-timeout'), 2000);
    child.stdout!.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 65_536) terminate(label + '-output-limit'); else output += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 65_536) terminate(label + '-output-limit'); });
    child.on('error', () => { failure = label + '-unavailable'; });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (failure) { resolve({ exit: failure === label + '-unavailable' ? 4 : 2, result: commandResult(null, 'unavailable', 0, failure) }); return; }
      try {
        const result = JSON.parse(output) as CommandResult;
        requireV2(result.schemaVersion === 2 && typeof result.reason === 'string', 'invalid-child-output', 5);
        resolve({ exit: code ?? 5, result });
      } catch { resolve({ exit: 5, result: commandResult(null, 'error', 0, 'invalid-child-output') }); }
    });
  });
}
// Node startup flags must not inject modules into the package-owned deterministic
// child. This does not claim resistance to hostile same-user installed-code edits.
function cleanNodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; return env;
}
export async function ensureHost(workspace: Workspace): Promise<CommandResult> {
  const reader = await AdvisorStore.open(workspace);
  try {
    const view = reader.readView();
    if (view.host.token && view.host.expiresAt > Date.now()) return commandResult(null, 'read', view.host.generation, 'host-running', { heartbeat: view.host.heartbeat });
  } finally { reader.close(); }
  // Probe the real writer before detaching; a missing runtime/qualification is a
  // visible failure rather than a successful start of an immediately dead process.
  const writer = await AdvisorStore.open(workspace, true); writer.close();
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', SELF, 'run', '--workspace', workspace.path], {
      detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: cleanNodeEnvironment(),
    });
    let finished = false;
    const finish = (result: CommandResult): void => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (child.connected) child.disconnect(); child.unref(); resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(commandResult(null, 'unavailable', 0, 'host-start-timeout')); }, 1500);
    child.on('message', message => {
      const data = message as Partial<CommandResult>;
      if (data.schemaVersion === 2 && typeof data.reason === 'string') finish(data as CommandResult);
    });
    child.on('error', () => finish(commandResult(null, 'unavailable', 0, 'host-unavailable')));
    child.on('exit', () => finish(commandResult(null, 'unavailable', 0, 'host-start-failed')));
  });
}
export async function stopHost(workspace: Workspace, requestId: string, expected: number): Promise<CommandResult> {
  const writer = await AdvisorStore.open(workspace, true);
  try { return writer.lease(requestId, expected, randomUUID(), 'stop'); } finally { writer.close(); }
}
export async function runHost(workspace: Workspace): Promise<void> {
  const store = await AdvisorStore.open(workspace, true);
  const token = randomUUID(); let generation: number;
  try {
    const current = store.readView();
    const acquired = store.lease(randomUUID(), current.host.generation, token, 'acquire');
    generation = acquired.revision;
    process.send?.(commandResult(null, 'applied', generation, 'host-running'));
  } catch (error) { store.close(); throw error; }
  let stopped = false, ticking = false, next = 0, renewAt = 0;
  let childWork: Promise<unknown> | null = null;
  const stop = (): void => { stopped = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopped) {
      // Renew before any spawn. An uncertain/failed commit ends this scheduler.
      if (Date.now() >= renewAt) {
        try { store.lease(randomUUID(), generation, token, 'renew'); renewAt = Date.now() + 5000; }
        catch { break; }
      }
      const view = store.readView(), now = Date.now();
      if (view.host.generation !== generation || view.host.token !== token) break;
      if (!ticking && now >= next) {
        ticking = true; next = now + Math.max(60_000, view.meta.config.minIntervalMs);
        childWork = boundedTick(workspace, 'host', { token, generation }).then(result => {
          // Disk failures stop this host's new analysis. Its lease will expire.
          if (result.exit === 5) stopped = true;
        }).finally(() => { ticking = false; });
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
    }
    if (childWork) await childWork;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    store.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  requireV2(args.length === 3 && ['run', 'ensure', 'status'].includes(args[0]) && args[1] === '--workspace', 'invalid-host-argv');
  const workspace = canonicalWorkspace(args[2]);
  if (args[0] === 'run') { await runHost(workspace); return; }
  const result = args[0] === 'ensure' ? await ensureHost(workspace) : await (async () => {
    const store = await AdvisorStore.open(workspace);
    try { const view = store.readView(); return commandResult(null, 'read', view.host.generation, view.host.expiresAt > Date.now() ? 'host-running' : 'host-stale', { host: view.host }); }
    finally { store.close(); }
  })();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.outcome === 'unavailable') process.exitCode = 4;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(error => {
    process.stderr.write(JSON.stringify(commandResult(null, 'error', 0, error instanceof AdvisorError ? error.reason : 'host-error')) + '\n');
    process.exitCode = error instanceof AdvisorError ? error.exit : 5;
  });
}
