/** Operator configuration is the only project authority; queue notes are not grants. */
export interface ConsoleConfig {
  projects: readonly Readonly<{ id: string; taskQueue: string; taskIds: readonly string[] }>[];
  grants: readonly Readonly<{ principalId: string; projects: readonly string[] }>[];
}
export type ConsoleView = 'tasks' | 'requests' | 'releases' | 'approvals' | 'evidence';
export interface ConsoleTask {
  taskId: string;
  projectId: string;
  revision: string;
  title: null;
  recordedStatus: string;
  lifecycle: 'queued' | 'pending' | 'unknown';
  archive: boolean;
  updatedAt: string | null;
  observedAt: null;
  attempt: null;
  sid: null;
  operation: null;
  phase: null;
  tool: null;
  surface: null;
  requestedModel: null;
  requestedEffort: null;
  observedModel: null;
  observedEffort: null;
  blocker: null;
  resumeOwner: null;
  release: null;
  reasons: readonly string[];
}
export interface ConsolePage {
  schemaVersion: 1;
  projectId: string;
  projectionRevision: string | null;
  sourceRevisions: readonly Readonly<{ source: 'task_queue_projection'; revision: string }>[];
  observedAt: null;
  fetchedAt: string | null;
  generatedAt: string;
  currentness: 'unknown';
  coverage: 'complete' | 'partial' | 'unavailable';
  warnings: readonly string[];
  items: readonly ConsoleTask[];
  total: number | null;
  nextCursor: string | null;
}
export const consoleId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
