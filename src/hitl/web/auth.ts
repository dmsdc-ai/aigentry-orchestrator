/**
 * Owner B — passkey authentication adapter for the approval inbox (U1).
 *
 * Implements the `AuthPort` contract from `./auth-port.js` on top of the pinned
 * `@simplewebauthn/server@14.0.2` package, which is reached only through a lazy
 * dynamic import so that the rest of the service keeps working (and reports
 * `dependency_unverified`) when the dependency is absent or incompatible.
 *
 * This module owns private authentication state only: it never reads HITL task
 * or gate files, never executes commands and never produces approval effects.
 *
 * Storage note: the private auth metadata document is protected by the reviewed
 * owned persistence helpers — `withIndexLock` (cross-process, hard-link +
 * PID-stale-detection) over `atomicWrite` (0600 temp + fsync + rename + parent
 * fsync) with `canonicalBytes` supplying deterministic sorted-key bytes. This
 * module adds no second locking or durable-write protocol. The promise chain
 * below is only in-process reentrancy serialization *around* those helpers:
 * `inspectLock` reports a self-held lock as "held", so a re-entrant call from
 * this process would otherwise block for the full acquire timeout.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { atomicWrite } from '../../session/persistence/atomic-write.js';
import { withIndexLock } from '../../session/persistence/index-lock.js';
import { canonicalBytes } from '../../session/persistence/canonical-bytes.js';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import type { AuthPort, AuthState, Principal } from './auth-port.js';

type WebAuthnServer = typeof import('@simplewebauthn/server');

const METADATA_VERSION = 1;
const METADATA_FILE = 'auth-metadata.json';
/** `atomicWrite` namespaces its temp as `<target>.tmp.<sessionId>.<pid>`; stable here so a
 *  retried write reuses its own temp instead of orphaning one. Must contain no separator. */
const WRITE_SESSION_ID = 'hitl-web-auth';
const SESSION_COOKIE = '__Host-inbox';
const PREAUTH_COOKIE = '__Host-inbox-preauth';
const CSRF_HEADER = 'x-inbox-csrf';
const RP_NAME = 'Approval inbox';
const OWNER_NAME = 'inbox-owner';

const CHALLENGE_MS = 120_000;
const PREAUTH_MS = 600_000;
const SESSION_IDLE_MS = 900_000;
const SESSION_ABSOLUTE_MS = 28_800_000;
const INVITATION_MS = 300_000;
const RATE_WINDOW_MS = 300_000;

const MAX_BODY = 65_536;
const MAX_METADATA_BYTES = 65_536;
const MAX_PREAUTH = 32;
const MAX_SESSIONS = 16;
const MAX_RATE_KEYS = 32;
const MAX_PREAUTH_PER_WINDOW = 60;
const MAX_INVITATION_ATTEMPTS = 10;
const MAX_LOGIN_ATTEMPTS = 30;
const LOCK_TIMEOUT_MS = 10_000;
const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43; // base64url length of 32 bytes

const ROUTES = new Set([
  '/auth/preauth',
  '/auth/enroll/options',
  '/auth/enroll/verify',
  '/auth/login/options',
  '/auth/login/verify',
  '/auth/logout',
]);

/** Owner-only guarantees are only claimed on platforms whose modes this code checks. */
const POSIX_PLATFORM = process.platform === 'darwin' || process.platform === 'linux';

// ---------------------------------------------------------------------------
// Private persisted document
// ---------------------------------------------------------------------------

interface StoredInvitation {
  hash: string;
  createdAt: number;
  expiresAt: number;
}
interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  userHandle: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: number;
}
interface Metadata {
  version: number;
  generation: number;
  invitation: StoredInvitation | null;
  credential: StoredCredential | null;
}
type MetadataRead =
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string }
  | { status: 'ok'; value: Metadata };

// ---------------------------------------------------------------------------
// Ephemeral in-memory state (invalidated by close and by process restart)
// ---------------------------------------------------------------------------

interface Challenge {
  purpose: 'enroll' | 'login';
  expected: string;
  expiresAt: number;
  invitationHash: string | null;
  userHandle: string | null;
}
interface PreauthRecord {
  csrfHash: string;
  createdAt: number;
  expiresAt: number;
  challenge: Challenge | null;
}
interface SessionRecord {
  handle: string;
  csrfHash: string;
  principalId: string;
  credentialId: string;
  generation: number;
  createdAt: number;
  lastSeenAt: number;
}

interface Snapshot {
  state: AuthState;
  reason: string | null;
}

export interface ProvisionOptions {
  authRoot: string;
  invitationPath: string;
}
export type ProvisionResult =
  | Readonly<{ state: 'created'; path: string }>
  | Readonly<{ state: 'unavailable'; reason: string }>;

// ---------------------------------------------------------------------------
// Small helpers — no secret ever reaches a response body, header or error text
// ---------------------------------------------------------------------------

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const token = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const isToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);

const isBase64Url = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function bounded(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => bounded(item, depth + 1));
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return keys.length <= 64 && keys.every(key => bounded((value as Record<string, unknown>)[key], depth + 1));
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) return null;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    return isToken(value) ? value : null;
  }
  return null;
}

const setCookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
const clearCookie = (name: string): string =>
  `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;

function reply(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): true {
  const head: Record<string, string | string[]> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (cookies.length) head['Set-Cookie'] = cookies;
  res.writeHead(status, head);
  res.end(JSON.stringify(body));
  return true;
}
const refuse = (res: ServerResponse, status: number, error: string, cookies: string[] = []): true =>
  reply(res, status, { error }, cookies);

// ---------------------------------------------------------------------------
// Filesystem safety and the local serialized atomic write
// ---------------------------------------------------------------------------

type PathCheck = 'ok' | 'missing' | 'unsafe';

/**
 * Walk every component: nothing may be a symlink or a non-directory, and the
 * leaf must be owned by this process. Parent directories remain a trusted-owner
 * deployment precondition; this is not a solved hostile-parent race.
 */
async function checkDirectory(path: string, ownerOnly: boolean): Promise<PathCheck> {
  if (!isAbsolute(path) || !POSIX_PLATFORM || typeof process.getuid !== 'function') return 'unsafe';
  const uid = process.getuid();
  const root = parse(path).root;
  const parts = relative(root, path).split(sep).filter(Boolean);
  if (!parts.length) return 'unsafe';
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index] as string);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe';
    if (index === parts.length - 1) {
      if (info.uid !== uid) return 'unsafe';
      if (ownerOnly && (info.mode & 0o077) !== 0) return 'unsafe';
    }
  }
  return 'ok';
}

/** Regular, owner-owned, non-symlink, no group/other access. */
async function checkFile(path: string): Promise<PathCheck> {
  if (!POSIX_PLATFORM || typeof process.getuid !== 'function') return 'unsafe';
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
  if (info.isSymbolicLink() || !info.isFile()) return 'unsafe';
  if (info.uid !== process.getuid()) return 'unsafe';
  return (info.mode & 0o077) === 0 ? 'ok' : 'unsafe';
}

// ---------------------------------------------------------------------------
// Sanitisers for the two library response shapes (bounded input before verify)
// ---------------------------------------------------------------------------

function transports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 16 && /^[a-z-]+$/.test(item))
    .slice(0, 8);
}

function registrationResponse(value: unknown): RegistrationResponseJSON | null {
  const root = record(value);
  const inner = root && record(root['response']);
  if (!root || !inner) return null;
  if (root['type'] !== 'public-key') return null;
  if (!isBase64Url(root['id'], 512) || !isBase64Url(root['rawId'], 512) || root['id'] !== root['rawId']) return null;
  if (!isBase64Url(inner['clientDataJSON'], 8192) || !isBase64Url(inner['attestationObject'], 32768)) return null;
  const list = transports(inner['transports']);
  return {
    id: root['id'],
    rawId: root['rawId'],
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: inner['clientDataJSON'],
      attestationObject: inner['attestationObject'],
      ...(list.length ? { transports: list } : {}),
    },
  };
}

function authenticationResponse(value: unknown): AuthenticationResponseJSON | null {
  const root = record(value);
  const inner = root && record(root['response']);
  if (!root || !inner) return null;
  if (root['type'] !== 'public-key') return null;
  if (!isBase64Url(root['id'], 512) || !isBase64Url(root['rawId'], 512) || root['id'] !== root['rawId']) return null;
  if (!isBase64Url(inner['clientDataJSON'], 8192) || !isBase64Url(inner['authenticatorData'], 8192)) return null;
  if (!isBase64Url(inner['signature'], 8192)) return null;
  const userHandle = inner['userHandle'];
  return {
    id: root['id'],
    rawId: root['rawId'],
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: inner['clientDataJSON'],
      authenticatorData: inner['authenticatorData'],
      signature: inner['signature'],
      ...(isBase64Url(userHandle, 512) ? { userHandle } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AuthConfig {
  origin: string;
  rpId: string;
  stateDir: string;
  tlsReady: boolean;
}
interface ValidConfig {
  origin: string;
  host: string;
  rpId: string;
  stateDir: string;
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A is required to supply an immutable validated owner config; nothing here is request-derived. */
function validateConfig(config: Readonly<AuthConfig>): ValidConfig | null {
  if (!config || typeof config !== 'object') return null;
  const { origin, rpId, stateDir, tlsReady } = config;
  if (typeof origin !== 'string' || typeof rpId !== 'string' || typeof stateDir !== 'string') return null;
  if (typeof tlsReady !== 'boolean') return null;
  if (origin.length > 255 || rpId.length > 255 || stateDir.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const id = rpId.toLowerCase();
  if (!HOSTNAME.test(id)) return null;
  if (host !== id && !host.endsWith(`.${id}`)) return null;
  if (!isAbsolute(stateDir)) return null;
  const root = parse(stateDir).root;
  const parts = relative(root, stateDir).split(sep).filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) return null;
  return { origin, host: url.host, rpId: id, stateDir };
}

// ---------------------------------------------------------------------------
// Metadata read/write
// ---------------------------------------------------------------------------

/**
 * `JSON.parse` keeps the last of repeated object keys, so metadata carrying a
 * second `"version"` would parse as a well-formed document and hide whatever
 * the earlier copy said. Rescan the raw bytes and report whether every object
 * in them names each key once, at every depth; names are compared decoded, so
 * an escaped spelling collides with its plain twin. Nesting past the bound is
 * reported as not unique — uniqueness is unproven there, and real metadata is
 * two levels deep. Deliberately a local copy of the read-model scanner: that
 * file belongs to another owner.
 *
 * Only valid JSON may be passed. String literals are consumed whole, so the
 * scan stays in step with the document and never reads a brace or a `:` that
 * was really string content.
 */
function uniqueKeys(raw: string): boolean {
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      if (stack.length >= 64) return false;
      stack.push(token === '{' ? new Set<string>() : null);
    } else if (token === '}' || token === ']') {
      stack.pop();
    } else if (token?.startsWith('"') && tokens[i + 1] === ':') {
      // A `Set` holds the names, so `__proto__` and friends stay ordinary keys.
      const keys = stack.at(-1);
      const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
}

function parseMetadata(raw: string): Metadata | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!uniqueKeys(raw)) return null;
  const root = record(value);
  if (!root) return null;
  if (root['version'] !== METADATA_VERSION) return null;
  const generation = root['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null;

  let invitation: StoredInvitation | null = null;
  if (root['invitation'] !== null) {
    const source = record(root['invitation']);
    if (!source || !isHex64(source['hash'])) return null;
    const createdAt = source['createdAt'];
    const expiresAt = source['expiresAt'];
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) return null;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return null;
    invitation = { hash: source['hash'], createdAt, expiresAt };
  }

  let credential: StoredCredential | null = null;
  if (root['credential'] !== null) {
    const source = record(root['credential']);
    if (!source) return null;
    const counter = source['counter'];
    const createdAt = source['createdAt'];
    if (!isBase64Url(source['id'], 512) || !isBase64Url(source['publicKey'], 8192)) return null;
    if (!isBase64Url(source['userHandle'], 512)) return null;
    if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) return null;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) return null;
    if (typeof source['deviceType'] !== 'string' || source['deviceType'].length > 32) return null;
    if (typeof source['backedUp'] !== 'boolean') return null;
    if (!Array.isArray(source['transports'])) return null;
    credential = {
      id: source['id'],
      publicKey: source['publicKey'],
      counter,
      transports: transports(source['transports']),
      userHandle: source['userHandle'],
      deviceType: source['deviceType'],
      backedUp: source['backedUp'],
      createdAt,
    };
  }
  return { version: METADATA_VERSION, generation, invitation, credential };
}

async function readMetadata(stateDir: string): Promise<MetadataRead> {
  const directory = await checkDirectory(stateDir, true);
  if (directory === 'missing') return { status: 'missing' };
  if (directory === 'unsafe') return { status: 'corrupt', reason: 'storage_unsafe' };
  const file = join(stateDir, METADATA_FILE);
  const state = await checkFile(file);
  if (state === 'missing') return { status: 'missing' };
  if (state === 'unsafe') return { status: 'corrupt', reason: 'storage_unsafe' };
  let raw: string;
  try {
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_METADATA_BYTES) return { status: 'corrupt', reason: 'storage_corrupt' };
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return { status: 'corrupt', reason: 'storage_unavailable' };
  }
  const parsed = parseMetadata(raw);
  // Corrupt storage is preserved as-is; there is no reset-to-empty fallback.
  return parsed ? { status: 'ok', value: parsed } : { status: 'corrupt', reason: 'storage_corrupt' };
}

/** Durable write is entirely the owned helper's: 0600 temp + fsync + rename + parent fsync. */
async function writeMetadata(stateDir: string, value: Metadata): Promise<void> {
  await atomicWrite(join(stateDir, METADATA_FILE), canonicalBytes(value), {
    sessionId: WRITE_SESSION_ID,
  });
}

/**
 * In-process reentrancy serialization only — it does not lock anything by
 * itself. `inspectLock` classifies a lock whose recorded pid is our own as
 * "held", so two overlapping critical sections in this process would otherwise
 * wait out the whole acquire timeout. Chaining them keeps `withIndexLock` the
 * single cross-process authority.
 */
function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  const settle = (): undefined => undefined;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(settle, settle);
    return next;
  };
}

/** Serialized `withIndexLock` over the metadata document (lock file `<target>.lock`). */
function createMetadataLock(stateDir: string | null): <T>(fn: () => Promise<T>) => Promise<T> {
  const serialize = createSerializer();
  const target = stateDir === null ? null : join(stateDir, METADATA_FILE);
  return <T>(fn: () => Promise<T>): Promise<T> =>
    target === null
      ? Promise.reject(new Error('config_invalid'))
      : serialize(() => withIndexLock(target, fn, { timeoutMs: LOCK_TIMEOUT_MS }));
}

// ---------------------------------------------------------------------------
// createAuth
// ---------------------------------------------------------------------------

export async function createAuth(
  config: Readonly<{ origin: string; rpId: string; stateDir: string; tlsReady: boolean }>,
  clock: () => number,
): Promise<AuthPort> {
  const now = (): number => {
    const value = clock();
    return Number.isFinite(value) ? value : Number.NaN;
  };

  // Lazy: the package is only touched here, never at module load.
  let lib: WebAuthnServer | null = null;
  let libReason: string | null = null;
  try {
    lib = await import('@simplewebauthn/server');
    if (
      typeof lib.generateRegistrationOptions !== 'function' ||
      typeof lib.verifyRegistrationResponse !== 'function' ||
      typeof lib.generateAuthenticationOptions !== 'function' ||
      typeof lib.verifyAuthenticationResponse !== 'function'
    ) {
      lib = null;
      libReason = 'dependency_incompatible';
    }
  } catch {
    lib = null;
    libReason = 'dependency_unverified';
  }

  const valid = validateConfig(config);
  const withLock = createMetadataLock(valid ? valid.stateDir : null);

  let snapshot: Snapshot = { state: 'dependency_unverified', reason: libReason ?? 'dependency_unverified' };
  let metadata: Metadata | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let closed = false;

  const preauths = new Map<string, PreauthRecord>();
  const sessions = new Map<string, SessionRecord>();
  const rates = new Map<string, { count: number; windowStart: number }>();

  function allow(key: string, limit: number): boolean {
    const time = now();
    if (!Number.isFinite(time)) return false;
    for (const [name, entry] of rates) {
      if (time - entry.windowStart >= RATE_WINDOW_MS) rates.delete(name);
    }
    const entry = rates.get(key);
    if (!entry) {
      if (rates.size >= MAX_RATE_KEYS) return false; // bounded map fails closed
      rates.set(key, { count: 1, windowStart: time });
      return true;
    }
    if (++entry.count > limit) return false;
    return true;
  }

  function sweep(): void {
    const time = now();
    if (!Number.isFinite(time)) return;
    for (const [key, entry] of preauths) {
      if (time >= entry.expiresAt) preauths.delete(key);
    }
    for (const [key, entry] of sessions) {
      if (time - entry.lastSeenAt >= SESSION_IDLE_MS || time - entry.createdAt >= SESSION_ABSOLUTE_MS) {
        sessions.delete(key);
      }
    }
  }

  function classify(): Snapshot {
    if (!lib) return { state: 'dependency_unverified', reason: libReason ?? 'dependency_unverified' };
    if (!valid) return { state: 'setup_required', reason: 'config_invalid' };
    if (!config.tlsReady) return { state: 'setup_required', reason: 'tls_required' };
    if (!POSIX_PLATFORM) return { state: 'setup_required', reason: 'platform_unsupported' };
    if (!metadata) return { state: 'setup_required', reason: 'provisioning_required' };
    if (metadata.credential) return { state: 'ready', reason: null };
    const time = now();
    if (metadata.invitation && Number.isFinite(time) && time < metadata.invitation.expiresAt) {
      return { state: 'setup_required', reason: 'enrollment_required' };
    }
    return { state: 'setup_required', reason: 'provisioning_required' };
  }

  async function refresh(force: boolean): Promise<Snapshot> {
    if (closed) {
      snapshot = { state: 'setup_required', reason: 'closed' };
      return snapshot;
    }
    const time = now();
    if (!lib || !valid || !config.tlsReady || !POSIX_PLATFORM) {
      metadata = null;
      snapshot = classify();
      return snapshot;
    }
    if (force || !Number.isFinite(refreshedAt) || !Number.isFinite(time) || time - refreshedAt >= 250) {
      const read = await readMetadata(valid.stateDir);
      if (read.status === 'ok') {
        metadata = read.value;
        refreshedAt = Number.isFinite(time) ? time : refreshedAt;
        snapshot = classify();
        return snapshot;
      }
      metadata = null;
      refreshedAt = Number.isFinite(time) ? time : refreshedAt;
      snapshot =
        read.status === 'corrupt'
          ? { state: 'setup_required', reason: read.reason }
          : { state: 'setup_required', reason: 'provisioning_required' };
      return snapshot;
    }
    snapshot = classify();
    return snapshot;
  }

  // ---- request plumbing ---------------------------------------------------

  async function body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const declared = req.headers['content-length'];
    if (typeof declared !== 'string' || !/^\d{1,7}$/.test(declared)) return null;
    const length = Number(declared);
    if (length > MAX_BODY) return null;
    const chunks: Buffer[] = [];
    let used = 0;
    try {
      for await (const chunk of req) {
        const piece = chunk as Buffer;
        used += piece.length;
        if (used > length) {
          req.destroy();
          return null;
        }
        chunks.push(piece);
      }
    } catch {
      return null;
    }
    if (used !== length) return null;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
    const root = record(value);
    return root && bounded(root, 0) ? root : null;
  }

  /** Exact configured Origin + Host, JSON and same-origin Fetch Metadata, re-checked here. */
  function trusted(req: IncomingMessage, host: string, origin: string): boolean {
    if (req.headers.host !== host) return false;
    if (req.headers.origin !== origin) return false;
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const mode = req.headers['sec-fetch-mode'];
    if (mode !== undefined && mode !== 'cors' && mode !== 'same-origin') return false;
    const contentType = req.headers['content-type'];
    return typeof contentType === 'string' && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
  }

  function preauthOf(req: IncomingMessage): { key: string; entry: PreauthRecord } | null {
    const raw = cookie(req, PREAUTH_COOKIE);
    if (!raw) return null;
    const key = sha256(raw);
    const entry = preauths.get(key);
    if (!entry) return null;
    const time = now();
    if (!Number.isFinite(time) || time >= entry.expiresAt) {
      preauths.delete(key);
      return null;
    }
    return { key, entry };
  }

  function sessionOf(req: IncomingMessage): { key: string; entry: SessionRecord } | null {
    const raw = cookie(req, SESSION_COOKIE);
    if (!raw) return null;
    const key = sha256(raw);
    const entry = sessions.get(key);
    if (!entry) return null;
    const time = now();
    if (
      !Number.isFinite(time) ||
      time - entry.lastSeenAt >= SESSION_IDLE_MS ||
      time - entry.createdAt >= SESSION_ABSOLUTE_MS
    ) {
      sessions.delete(key);
      return null;
    }
    return { key, entry };
  }

  function csrfOk(req: IncomingMessage, hash: string): boolean {
    const header = req.headers[CSRF_HEADER];
    if (!isToken(header)) return false;
    return constantTimeEqual(sha256(header), hash);
  }

  /** Remove the challenge before verifying: no concurrent replay, no retry after failure. */
  function claim(entry: PreauthRecord, purpose: 'enroll' | 'login'): Challenge | null {
    const challenge = entry.challenge;
    entry.challenge = null;
    if (!challenge || challenge.purpose !== purpose) return null;
    const time = now();
    if (!Number.isFinite(time) || time >= challenge.expiresAt) return null;
    return challenge;
  }

  function issueSession(credential: StoredCredential, generation: number): { cookie: string; csrf: string; expiresAt: number } {
    sweep();
    const time = now();
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
    const raw = token();
    const csrf = token();
    sessions.set(sha256(raw), {
      handle: randomBytes(16).toString('hex'),
      csrfHash: sha256(csrf),
      principalId: OWNER_NAME,
      credentialId: credential.id,
      generation,
      createdAt: time,
      lastSeenAt: time,
    });
    return { cookie: raw, csrf, expiresAt: time + Math.min(SESSION_IDLE_MS, SESSION_ABSOLUTE_MS) };
  }

  // ---- routes -------------------------------------------------------------

  async function routePreauth(res: ServerResponse): Promise<true> {
    if (!allow('preauth', MAX_PREAUTH_PER_WINDOW)) return refuse(res, 429, 'rate_limited');
    sweep();
    while (preauths.size >= MAX_PREAUTH) {
      const oldest = [...preauths.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      preauths.delete(oldest[0]);
    }
    const time = now();
    if (!Number.isFinite(time)) return refuse(res, 503, 'auth_unavailable');
    const raw = token();
    const csrf = token();
    preauths.set(sha256(raw), {
      csrfHash: sha256(csrf),
      createdAt: time,
      expiresAt: time + PREAUTH_MS,
      challenge: null,
    });
    return reply(
      res,
      200,
      { csrf, csrfHeader: CSRF_HEADER, expiresIn: Math.floor(PREAUTH_MS / 1000) },
      [setCookie(PREAUTH_COOKIE, raw, Math.floor(PREAUTH_MS / 1000))],
    );
  }

  async function routeEnrollOptions(req: IncomingMessage, res: ServerResponse, entry: PreauthRecord): Promise<true> {
    if (!lib || !valid) return refuse(res, 503, 'auth_unavailable');
    if (!allow('invitation', MAX_INVITATION_ATTEMPTS)) return refuse(res, 429, 'rate_limited');
    const payload = await body(req);
    if (!payload) return refuse(res, 400, 'invalid_json');
    const invitation = payload['invitation'];
    if (!isToken(invitation)) return refuse(res, 400, 'invitation_invalid');

    const state = await refresh(true);
    if (state.state === 'ready') return refuse(res, 409, 'already_enrolled');
    if (!metadata || !metadata.invitation) return refuse(res, 503, 'enrollment_unavailable');
    const time = now();
    if (!Number.isFinite(time)) return refuse(res, 503, 'auth_unavailable');
    if (time >= metadata.invitation.expiresAt) return refuse(res, 410, 'invitation_expired');
    if (!constantTimeEqual(sha256(invitation), metadata.invitation.hash)) return refuse(res, 403, 'invitation_invalid');

    const challenge = Uint8Array.from(randomBytes(TOKEN_BYTES));
    const userHandle = Uint8Array.from(randomBytes(TOKEN_BYTES));
    let options: PublicKeyCredentialCreationOptionsJSON;
    try {
      options = await lib.generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: valid.rpId,
        userName: OWNER_NAME,
        userDisplayName: OWNER_NAME,
        userID: userHandle,
        challenge,
        timeout: CHALLENGE_MS,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
    } catch {
      return refuse(res, 503, 'auth_unavailable');
    }
    entry.challenge = {
      purpose: 'enroll',
      expected: options.challenge,
      expiresAt: time + CHALLENGE_MS,
      invitationHash: metadata.invitation.hash,
      userHandle: Buffer.from(userHandle).toString('base64url'),
    };
    return reply(res, 200, { options });
  }

  async function routeEnrollVerify(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    entry: PreauthRecord,
  ): Promise<true> {
    if (!lib || !valid) return refuse(res, 503, 'auth_unavailable');
    const payload = await body(req);
    const challenge = claim(entry, 'enroll');
    if (!payload) return refuse(res, 400, 'invalid_json');
    if (!challenge || !challenge.invitationHash || !challenge.userHandle) return refuse(res, 410, 'challenge_expired');
    const response = registrationResponse(payload['response']);
    if (!response) return refuse(res, 400, 'invalid_request');

    let verified;
    try {
      verified = await lib.verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.expected,
        expectedOrigin: valid.origin,
        expectedRPID: valid.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      return refuse(res, 403, 'verification_failed');
    }
    if (!verified.verified) return refuse(res, 403, 'verification_failed');
    if (!verified.registrationInfo.userVerified) return refuse(res, 403, 'user_verification_required');

    const info = verified.registrationInfo;
    const time = now();
    if (!Number.isFinite(time)) return refuse(res, 503, 'auth_unavailable');
    const stored: StoredCredential = {
      id: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: transports(info.credential.transports ?? response.response.transports),
      userHandle: challenge.userHandle,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      createdAt: time,
    };

    // Final recheck and the one-winner invitation consume + credential save
    // share the lock; the session is issued only after the durable write.
    let committed: { credential: StoredCredential; generation: number } | 'conflict' | 'unavailable';
    try {
      committed = await withLock(async () => {
        const current = await readMetadata(valid.stateDir);
        if (current.status !== 'ok') return 'unavailable' as const;
        if (current.value.credential) return 'conflict' as const;
        const pending = current.value.invitation;
        if (!pending || pending.hash !== challenge.invitationHash) return 'conflict' as const;
        if (now() >= pending.expiresAt) return 'conflict' as const;
        const next: Metadata = {
          version: METADATA_VERSION,
          generation: current.value.generation + 1,
          invitation: null,
          credential: stored,
        };
        await writeMetadata(valid.stateDir, next);
        metadata = next;
        return { credential: stored, generation: next.generation };
      });
    } catch {
      return refuse(res, 503, 'storage_unavailable');
    }
    if (committed === 'conflict') {
      await refresh(true);
      return refuse(res, 409, 'already_enrolled');
    }
    if (committed === 'unavailable') {
      await refresh(true);
      return refuse(res, 503, 'storage_unavailable');
    }

    await refresh(true);
    preauths.delete(key);
    const session = issueSession(committed.credential, committed.generation);
    return reply(
      res,
      200,
      { state: 'ready', csrf: session.csrf, csrfHeader: CSRF_HEADER, expiresAt: session.expiresAt },
      [
        setCookie(SESSION_COOKIE, session.cookie, Math.floor(SESSION_IDLE_MS / 1000)),
        clearCookie(PREAUTH_COOKIE),
      ],
    );
  }

  async function routeLoginOptions(res: ServerResponse, entry: PreauthRecord): Promise<true> {
    if (!lib || !valid) return refuse(res, 503, 'auth_unavailable');
    if (!allow('login', MAX_LOGIN_ATTEMPTS)) return refuse(res, 429, 'rate_limited');
    const state = await refresh(true);
    if (state.state !== 'ready' || !metadata || !metadata.credential) return refuse(res, 503, 'login_unavailable');
    const credential = metadata.credential;
    const time = now();
    if (!Number.isFinite(time)) return refuse(res, 503, 'auth_unavailable');
    let options: PublicKeyCredentialRequestOptionsJSON;
    try {
      options = await lib.generateAuthenticationOptions({
        rpID: valid.rpId,
        challenge: Uint8Array.from(randomBytes(TOKEN_BYTES)),
        timeout: CHALLENGE_MS,
        userVerification: 'required',
        allowCredentials: [
          { id: credential.id, ...(credential.transports.length ? { transports: credential.transports } : {}) },
        ],
      });
    } catch {
      return refuse(res, 503, 'auth_unavailable');
    }
    entry.challenge = {
      purpose: 'login',
      expected: options.challenge,
      expiresAt: time + CHALLENGE_MS,
      invitationHash: null,
      userHandle: null,
    };
    return reply(res, 200, { options });
  }

  async function routeLoginVerify(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    entry: PreauthRecord,
  ): Promise<true> {
    if (!lib || !valid) return refuse(res, 503, 'auth_unavailable');
    const payload = await body(req);
    const challenge = claim(entry, 'login');
    if (!payload) return refuse(res, 400, 'invalid_json');
    if (!challenge) return refuse(res, 410, 'challenge_expired');
    const response = authenticationResponse(payload['response']);
    if (!response) return refuse(res, 400, 'invalid_request');

    const state = await refresh(true);
    if (state.state !== 'ready' || !metadata || !metadata.credential) return refuse(res, 503, 'login_unavailable');
    const stored = metadata.credential;
    if (response.id !== stored.id) return refuse(res, 403, 'credential_unknown');
    // Captured so the narrowing above survives into the locked closure.
    const webauthn = lib;

    /**
     * Verified under the lock, against the credential read there rather than the
     * cached one. The library weighs the signature counter against the counter it
     * is handed, so verifying against a cached read lets two challenges signed
     * with the same counter both pass before either has written: each is measured
     * against a value the other is about to replace. Reading the credential and
     * judging its proof inside one critical section means every accepted proof is
     * measured against the latest durable counter, and only the first of those
     * two can commit. The counter rule stays the library's own — it still admits
     * authenticators that always report zero.
     */
    type Commit =
      | { status: 'ok'; credential: StoredCredential; generation: number }
      | { status: 'unavailable' }
      | { status: 'denied'; error: string };
    let committed: Commit;
    try {
      committed = await withLock(async (): Promise<Commit> => {
        const current = await readMetadata(valid.stateDir);
        if (current.status !== 'ok' || !current.value.credential) return { status: 'unavailable' };
        const live = current.value.credential;
        if (live.id !== stored.id) return { status: 'unavailable' };
        const credential: WebAuthnCredential = {
          id: live.id,
          publicKey: Uint8Array.from(Buffer.from(live.publicKey, 'base64url')),
          counter: live.counter,
          ...(live.transports.length ? { transports: live.transports } : {}),
        };

        let verified;
        try {
          verified = await webauthn.verifyAuthenticationResponse({
            response,
            expectedChallenge: challenge.expected,
            expectedOrigin: valid.origin,
            expectedRPID: valid.rpId,
            credential,
            requireUserVerification: true,
          });
        } catch {
          return { status: 'denied', error: 'verification_failed' };
        }
        if (!verified.verified) return { status: 'denied', error: 'verification_failed' };
        if (!verified.authenticationInfo.userVerified) {
          return { status: 'denied', error: 'user_verification_required' };
        }
        if (verified.authenticationInfo.credentialID !== live.id) {
          return { status: 'denied', error: 'credential_unknown' };
        }

        // Counter is persisted durably before any session is issued.
        const updated: StoredCredential = {
          ...live,
          counter: verified.authenticationInfo.newCounter,
        };
        const next: Metadata = { ...current.value, version: METADATA_VERSION, credential: updated };
        await writeMetadata(valid.stateDir, next);
        metadata = next;
        return { status: 'ok', credential: updated, generation: next.generation };
      });
    } catch {
      return refuse(res, 503, 'storage_unavailable');
    }
    if (committed.status === 'unavailable') {
      await refresh(true);
      return refuse(res, 503, 'storage_unavailable');
    }
    if (committed.status === 'denied') return refuse(res, 403, committed.error);

    await refresh(true);
    preauths.delete(key);
    const session = issueSession(committed.credential, committed.generation);
    return reply(
      res,
      200,
      { state: 'ready', csrf: session.csrf, csrfHeader: CSRF_HEADER, expiresAt: session.expiresAt },
      [
        setCookie(SESSION_COOKIE, session.cookie, Math.floor(SESSION_IDLE_MS / 1000)),
        clearCookie(PREAUTH_COOKIE),
      ],
    );
  }

  function routeLogout(req: IncomingMessage, res: ServerResponse): true {
    const found = sessionOf(req);
    if (!found) return refuse(res, 401, 'session_required', [clearCookie(SESSION_COOKIE)]);
    if (!csrfOk(req, found.entry.csrfHash)) return refuse(res, 403, 'csrf_required');
    sessions.delete(found.key);
    const preauth = preauthOf(req);
    if (preauth) preauths.delete(preauth.key);
    return reply(res, 200, { state: 'signed_out' }, [clearCookie(SESSION_COOKIE), clearCookie(PREAUTH_COOKIE)]);
  }

  // ---- AuthPort -----------------------------------------------------------

  await refresh(true);

  const port: AuthPort = {
    status: () => ({ state: snapshot.state, reason: snapshot.reason }),

    handle: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      // Never consume a request this module does not own.
      const target = req.url;
      if (typeof target !== 'string' || !target.startsWith('/')) return false;
      const path = target.split('?', 1)[0] ?? '';
      if (!ROUTES.has(path)) return false;
      if (closed) return refuse(res, 503, 'auth_unavailable');
      // State-changing GET (or anything else) on an auth route is refused here.
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return refuse(res, 405, 'method_refused');
      }
      if (target.includes('?')) return refuse(res, 400, 'invalid_request');
      if (!lib || !valid) return refuse(res, 503, 'auth_unavailable');
      if (!trusted(req, valid.host, valid.origin)) return refuse(res, 403, 'origin_refused');

      const state = await refresh(false);
      if (state.state === 'dependency_unverified') return refuse(res, 503, 'auth_unavailable');

      if (path === '/auth/preauth') return routePreauth(res);
      if (path === '/auth/logout') return routeLogout(req, res);

      const preauth = preauthOf(req);
      if (!preauth) return refuse(res, 401, 'preauth_required');
      if (!csrfOk(req, preauth.entry.csrfHash)) return refuse(res, 403, 'csrf_required');

      if (path === '/auth/enroll/options') return routeEnrollOptions(req, res, preauth.entry);
      if (path === '/auth/enroll/verify') return routeEnrollVerify(req, res, preauth.key, preauth.entry);
      if (path === '/auth/login/options') return routeLoginOptions(res, preauth.entry);
      if (path === '/auth/login/verify') return routeLoginVerify(req, res, preauth.key, preauth.entry);
      return refuse(res, 404, 'not_found');
    },

    authenticate: async (req: IncomingMessage): Promise<Principal | null> => {
      if (closed) return null;
      const state = await refresh(false);
      if (state.state !== 'ready' || !metadata || !metadata.credential) return null;
      const found = sessionOf(req);
      if (!found) return null;
      // An absent, replaced or revoked credential refuses authentication.
      if (found.entry.credentialId !== metadata.credential.id || found.entry.generation !== metadata.generation) {
        sessions.delete(found.key);
        return null;
      }
      const time = now();
      if (!Number.isFinite(time)) return null;
      found.entry.lastSeenAt = time;
      return {
        id: found.entry.principalId,
        credentialId: found.entry.credentialId,
        sessionId: found.entry.handle, // opaque handle, never the cookie value
        expiresAt: Math.min(time + SESSION_IDLE_MS, found.entry.createdAt + SESSION_ABSOLUTE_MS),
      };
    },

    close: async (): Promise<void> => {
      closed = true;
      preauths.clear();
      sessions.clear();
      rates.clear();
      metadata = null;
      snapshot = { state: 'setup_required', reason: 'closed' };
    },
  };
  return port;
}

// ---------------------------------------------------------------------------
// provisionOwner — trusted-OS operation for the later CLI owner
// ---------------------------------------------------------------------------

/**
 * Create the single-use owner enrollment invitation. This is never reachable
 * over HTTP and grants enrollment authority only — no operation approval.
 *
 * Returns the invitation file path only; the 256-bit value exists solely inside
 * the 0600 file so it is never logged, echoed or embedded anywhere else.
 * No CLI wiring is performed here.
 */
export async function provisionOwner(
  options: Readonly<ProvisionOptions>,
  clock: () => number = Date.now,
): Promise<ProvisionResult> {
  // Windows ACL semantics are unverified here, so owner-only cannot be claimed.
  if (!POSIX_PLATFORM || typeof process.getuid !== 'function') {
    return { state: 'unavailable', reason: 'platform_unsupported' };
  }
  const authRoot = options?.authRoot;
  const invitationPath = options?.invitationPath;
  if (typeof authRoot !== 'string' || typeof invitationPath !== 'string') {
    return { state: 'unavailable', reason: 'config_invalid' };
  }
  if (!isAbsolute(authRoot) || !isAbsolute(invitationPath)) {
    return { state: 'unavailable', reason: 'config_invalid' };
  }
  if (authRoot.length > 4096 || invitationPath.length > 4096) {
    return { state: 'unavailable', reason: 'config_invalid' };
  }
  for (const path of [authRoot, invitationPath]) {
    const root = parse(path).root;
    const parts = relative(root, path).split(sep).filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      return { state: 'unavailable', reason: 'config_invalid' };
    }
  }
  const time = clock();
  if (!Number.isFinite(time)) return { state: 'unavailable', reason: 'config_invalid' };

  // 0700 owner-only auth root; created only if entirely absent.
  let rootState = await checkDirectory(authRoot, true);
  if (rootState === 'missing') {
    try {
      await mkdir(authRoot, { recursive: false, mode: 0o700 });
    } catch {
      return { state: 'unavailable', reason: 'storage_unsafe' };
    }
    rootState = await checkDirectory(authRoot, true);
  }
  if (rootState !== 'ok') return { state: 'unavailable', reason: 'storage_unsafe' };
  if ((await checkDirectory(dirname(invitationPath), true)) !== 'ok') {
    return { state: 'unavailable', reason: 'storage_unsafe' };
  }
  if ((await checkFile(invitationPath)) !== 'missing') {
    return { state: 'unavailable', reason: 'provision_conflict' };
  }

  const withLock = createMetadataLock(authRoot);
  try {
    return await withLock(async (): Promise<ProvisionResult> => {
      const current = await readMetadata(authRoot);
      if (current.status === 'corrupt') return { state: 'unavailable', reason: current.reason };
      const existing: Metadata = current.status === 'ok'
        ? current.value
        : { version: METADATA_VERSION, generation: 0, invitation: null, credential: null };
      // Never silently take an invitation over an existing owner.
      if (existing.credential) return { state: 'unavailable', reason: 'already_enrolled' };
      if (existing.invitation && clock() < existing.invitation.expiresAt) {
        return { state: 'unavailable', reason: 'provision_conflict' };
      }

      const value = randomBytes(TOKEN_BYTES).toString('base64url');
      // Deliberately NOT atomicWrite: exclusive creation *is* the collision check here,
      // and a rename-over would silently clobber an existing invitation file.
      let handle;
      try {
        handle = await open(
          invitationPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { state: 'unavailable', reason: code === 'EEXIST' ? 'provision_conflict' : 'storage_unsafe' };
      }
      try {
        await handle.writeFile(`${value}\n`, 'utf8');
        await handle.sync();
      } catch {
        await handle.close().catch(() => undefined);
        await unlink(invitationPath).catch(() => undefined);
        return { state: 'unavailable', reason: 'storage_unavailable' };
      }
      await handle.close();

      const issued = clock();
      const next: Metadata = {
        version: METADATA_VERSION,
        generation: existing.generation,
        invitation: { hash: sha256(value), createdAt: issued, expiresAt: issued + INVITATION_MS },
        credential: null,
      };
      try {
        await writeMetadata(authRoot, next);
      } catch {
        // Roll back only the file this call created.
        await unlink(invitationPath).catch(() => undefined);
        return { state: 'unavailable', reason: 'storage_unavailable' };
      }
      return { state: 'created', path: invitationPath };
    });
  } catch {
    return { state: 'unavailable', reason: 'storage_busy' };
  }
}
