import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const authoritativeKinds = Object.freeze([
  'completion.accepted', 'artifact.corrected', 'artifact.retracted', 'artifact.tombstoned',
] as const);
const auditKinds = Object.freeze(['task.failure', 'task.hold', 'task.checkpoint'] as const);

/** Structural deduplication identity only; never an authenticated ingestion receipt. */
export type KnowledgeEventIdentity = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  artifactId: string;
  artifactRevision: number;
  artifactSha256: string;
} & (
  | { eventClass: 'authoritative'; kind: typeof authoritativeKinds[number] }
  | { eventClass: 'audit.evidence'; kind: typeof auditKinds[number] }
)>;

export type KnowledgeEventIdentityResult =
  | { readonly ok: true; readonly eventId: string; readonly identity: KnowledgeEventIdentity }
  | { readonly ok: false; readonly reason: string };

const fields = Object.freeze([
  'schemaVersion', 'eventClass', 'kind', 'tenantId', 'projectId', 'taskId',
  'attemptId', 'operationId', 'artifactId', 'artifactRevision', 'artifactSha256',
] as const);

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && value.trim() === value && Buffer.byteLength(value, 'utf8') <= 256
    && !/[\p{Cc}\p{Cs}]/u.test(value);
}

/**
 * Validates deserialized JSON without reading accessors or invoking toJSON.
 * Hostile JavaScript Proxy traps are outside this boundary.
 * External admission must authenticate origin, actor, grant, ACL and the required
 * acceptanceId or auditAdmissionRef before processing; this helper grants nothing.
 */
export function deriveKnowledgeEventId(input: unknown): KnowledgeEventIdentityResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'Expected a plain JSON object' };
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'Expected a plain JSON object' };
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length
    || keys.some(key => typeof key !== 'string' || !fields.some(field => field === key))) {
    return { ok: false, reason: 'Missing or unknown identity fields' };
  }
  const values = Object.create(null) as Record<typeof fields[number], unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { ok: false, reason: `Expected an own data field: ${field}` };
    }
    values[field] = descriptor.value;
  }
  const {
    schemaVersion, eventClass, kind, tenantId, projectId, taskId, attemptId,
    operationId, artifactId, artifactRevision, artifactSha256,
  } = values;
  if (schemaVersion !== 1) return { ok: false, reason: 'Expected schemaVersion 1' };
  if (!isIdentifier(tenantId) || !isIdentifier(projectId) || !isIdentifier(taskId)
    || !isIdentifier(attemptId) || !isIdentifier(operationId) || !isIdentifier(artifactId)) {
    return { ok: false, reason: 'Invalid identity identifier' };
  }
  if (typeof artifactRevision !== 'number' || !Number.isSafeInteger(artifactRevision)
    || artifactRevision < 0 || Object.is(artifactRevision, -0)) {
    return { ok: false, reason: 'Expected a nonnegative safe integer revision, excluding -0' };
  }
  if (typeof artifactSha256 !== 'string' || artifactSha256.length !== 64
    || !/^[a-f0-9]{64}$/.test(artifactSha256)) {
    return { ok: false, reason: 'Expected a lowercase SHA-256 digest' };
  }
  const common = {
    schemaVersion, tenantId, projectId, taskId, attemptId, operationId,
    artifactId, artifactRevision, artifactSha256,
  } as const;
  let identity: KnowledgeEventIdentity;
  if (eventClass === 'authoritative'
    && authoritativeKinds.some(allowed => allowed === kind)) {
    identity = Object.freeze({
      ...common, eventClass, kind: kind as typeof authoritativeKinds[number],
    });
  } else if (eventClass === 'audit.evidence' && auditKinds.some(allowed => allowed === kind)) {
    identity = Object.freeze({ ...common, eventClass, kind: kind as typeof auditKinds[number] });
  } else {
    return { ok: false, reason: 'Invalid event class and kind pairing' };
  }
  const canonical = JSON.stringify([
    'aigentry.knowledge-event', 1, identity.eventClass, identity.kind,
    tenantId, projectId, taskId, attemptId, operationId, artifactId,
    artifactRevision, artifactSha256,
  ]);
  // Storage must separately enforce unique identity with payload equality.
  // A hash is neither a cryptographic no-collision nor an exactly-once guarantee.
  const eventId = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  return { ok: true, eventId, identity };
}
