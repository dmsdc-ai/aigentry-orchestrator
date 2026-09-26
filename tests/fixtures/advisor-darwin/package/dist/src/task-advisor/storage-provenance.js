import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LIMITS, exactKeysV2, hashJson, recordV2, requireV2, textV2, uintV2, utcV2 } from './contracts.js';
/**
 * Package-owned, read-only storage-provenance measurement.
 *
 * This module answers exactly one question about exactly one already-resolved
 * directory: is the medium that directory currently lives on internal and fixed,
 * removable, reached over a network, or not established. It is the measurement
 * stage required by CONTRACT §1 and it implements the API selection recorded in
 * `input/ADAPTER-DECISION.md`.
 *
 * What this module deliberately is NOT:
 *
 * - It is not a device or mount enumerator. Every OS query names the one target
 *   volume that was bound from the caller's path; nothing scans `/sys`, walks the
 *   mount table for unrelated entries, or inspects other devices.
 * - It is not a privilege escalation path. Every call runs with the ordinary
 *   permissions of the current process. There is no prompt, no setuid helper and
 *   no root fallback: an access denial is reported as `unknown`, never retried
 *   with more authority.
 * - It is not a content reader. No byte of the target directory or of any file
 *   inside it is read, and no device serial, volume label or user-visible name is
 *   ever placed in the returned facts.
 * - It is not proof of physical media. A result describes one volume at one
 *   instant; a path may be bound to different media immediately afterwards, which
 *   is why the store's existing pre-open and second-stage checks still run.
 *
 * `statfs` format identity is never evidence of provenance here. A filesystem
 * format is a format; `apfs`, `ext4` and `ntfs` all appear on USB sticks.
 *
 * Failure direction is always toward refusal. Every error, timeout, denial,
 * oversize response, ambiguous topology, contradictory answer or missing helper
 * resolves to `unknown`, and `unknown` cannot qualify a production write.
 */
/** Wire protocol between this module and the package-owned native helpers. */
export const STORAGE_PROVENANCE_PROTOCOL = 'advisor-storage-provenance-v1';
/** Bumped whenever the measurement semantics or the wire protocol change. */
export const STORAGE_PROVENANCE_ADAPTER_VERSION = 1;
/** Hard ceilings. Exceeding any of these refuses rather than truncating. */
const HELPER_TIMEOUT_MS = 2_000;
const HELPER_MAX_OUTPUT_BYTES = 512;
const MOUNTINFO_MAX_BYTES = 1_048_576;
const SYSFS_MAX_BYTES = 64;
const MAX_WALL_MS = 3_000;
const MAX_BYTES_READ = 2 * 1_048_576;
const MAX_PACKAGE_SEARCH_DEPTH = 6;
/** Filesystem types that are, by their own definition, reached over a network. */
const NETWORK_FILESYSTEMS = new Set([
    'nfs', 'nfs3', 'nfs4', 'cifs', 'smbfs', 'smb2', 'smb3', 'afs', 'afpfs', 'ncpfs',
    '9p', 'ceph', 'glusterfs', 'lustre', 'gfs2', 'ocfs2', 'davfs', 'webdav',
    'fuse.sshfs', 'fuse.s3fs', 'fuse.rclone', 'fuse.davfs2', 'fuse.glusterfs',
    'beegfs', 'orangefs', 'pvfs2', 'coda', 'aufs.nfs',
]);
/**
 * Sysfs topology segments that mean the device is attached over a hot-pluggable
 * transport. Presence of any of these refuses `local-fixed` regardless of what the
 * `removable` attribute says, because an internal-looking bridge behind USB is
 * still removable media.
 */
const HOTPLUG_TRANSPORTS = ['/usb', '/mmc_host/', '/mmc/', '/firewire', '/ieee1394', '/thunderbolt'];
/** Read at most `cap` bytes. `/proc` and `/sys` report size 0, so never trust stat. */
function readBounded(file, cap) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
        const buffer = Buffer.alloc(cap + 1);
        let count = 0;
        while (count < buffer.length) {
            const n = fs.readSync(fd, buffer, count, buffer.length - count, null);
            if (!n)
                break;
            count += n;
        }
        requireV2(count <= cap, 'storage-provenance-oversize');
        return { text: buffer.subarray(0, count).toString('utf8'), bytes: count };
    }
    finally {
        fs.closeSync(fd);
    }
}
/** `mountinfo` octal-escapes space, tab, newline and backslash in path fields. */
function unescapeMountField(value) {
    return value.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
}
/** True when `canonical` is the mount point itself or lies beneath it. */
function underMountPoint(canonical, mountPoint) {
    if (canonical === mountPoint)
        return true;
    const prefix = mountPoint.endsWith('/') ? mountPoint : mountPoint + '/';
    return canonical.startsWith(prefix);
}
/**
 * Locate the package-owned helper by walking up from this module to the directory
 * that carries the package manifest, then taking a fixed relative path.
 *
 * The helper is never selected from `PATH`, an environment variable, configuration
 * or a workspace file: those are all caller-controlled, and a caller-controlled
 * binary could simply claim `local-fixed`. The search is bounded and the resolved
 * file must be a real, non-symlink regular file.
 */
function helperPath(platform, arch) {
    let directory;
    try {
        directory = path.dirname(fileURLToPath(import.meta.url));
    }
    catch {
        return null;
    }
    let root = null;
    for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth++) {
        if (fs.existsSync(path.join(directory, 'package.json'))
            && fs.existsSync(path.join(directory, 'native', 'task-advisor-storage'))) {
            root = directory;
            break;
        }
        const parent = path.dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    if (root === null)
        return null;
    const name = `advisor-storage-provenance-${platform}-${arch}` + (platform === 'win32' ? '.exe' : '');
    const file = path.join(root, 'native', 'task-advisor-storage', 'bin', name);
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        if (fs.realpathSync.native(file) !== file)
            return null;
    }
    catch {
        return null;
    }
    return file;
}
/**
 * Run the package-owned helper for exactly one path and parse its single line of
 * output under a strict grammar. Anything unexpected — extra tokens, reordered
 * keys, an unknown value, oversize output, a non-zero exit, a timeout, a signal —
 * is a refusal, never a best-effort interpretation.
 */
function runHelper(file, canonical, platform) {
    const env = platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '' }
        : {};
    const result = spawnSync(file, [canonical], {
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: HELPER_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.signal !== null || result.status !== 0)
        return null;
    const raw = result.stdout;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > HELPER_MAX_OUTPUT_BYTES)
        return null;
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.includes('\n'))
        return null;
    const tokens = line.split(' ');
    if (tokens.length !== 6)
        return null;
    if (tokens[0] !== STORAGE_PROVENANCE_PROTOCOL)
        return null;
    // Fixed key order, one `key=value` token each. A reordered or renamed key is a
    // different protocol, not a variant to accommodate.
    const keys = ['status', 'class', 'dev', 'internal', 'removable'];
    const fields = new Map();
    for (let index = 0; index < keys.length; index++) {
        const token = tokens[index + 1], key = keys[index];
        const split = token.indexOf('=');
        if (split <= 0 || token.slice(0, split) !== key)
            return null;
        fields.set(key, token.slice(split + 1));
    }
    const status = fields.get('status');
    if (!['ok', 'denied', 'unsupported', 'error'].includes(status))
        return null;
    const reported = fields.get('class');
    if (!['local-fixed', 'removable', 'network', 'unknown'].includes(reported))
        return null;
    const dev = fields.get('dev');
    if (dev !== 'u' && !/^-?\d{1,20}$/.test(dev))
        return null;
    for (const key of ['internal', 'removable']) {
        if (!['0', '1', 'u'].includes(fields.get(key)))
            return null;
    }
    // A helper that could not complete its query cannot assert a classification.
    if (status !== 'ok' && reported !== 'unknown')
        return null;
    // Contradiction guard: `local-fixed` requires the helper to have actually seen an
    // internal, non-removable volume. A bare verdict without its evidence is refused.
    // Only this direction is guarded; a `removable` verdict reached through hotplug
    // evidence legitimately carries `removable=0`, and refusing is never unsafe.
    if (reported === 'local-fixed' && (fields.get('internal') !== '1' || fields.get('removable') !== '0'))
        return null;
    return {
        status,
        classification: reported,
        dev: dev === 'u' ? null : dev,
        bytes: Buffer.byteLength(raw),
    };
}
/** Darwin: `statfs` for the format, Disk Arbitration for the one bound volume. */
function observeDarwin(canonical, dev, ino, arch) {
    const adapter = 'darwin-diskarbitration';
    const file = helperPath('darwin', arch);
    if (file === null) {
        return { classification: 'unknown', reason: 'storage-provenance-helper-absent', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: 0 };
    }
    const answer = runHelper(file, canonical, 'darwin');
    if (answer === null) {
        return { classification: 'unknown', reason: 'storage-provenance-helper-unusable', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: 0 };
    }
    // On Darwin the helper must independently confirm the device this process bound.
    // Without that confirmation the answer may describe a different volume entirely.
    if (answer.dev === null) {
        return { classification: 'unknown', reason: 'storage-provenance-unbound-volume', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: answer.bytes };
    }
    if (answer.dev !== String(dev)) {
        return { classification: 'unknown', reason: 'storage-provenance-volume-mismatch', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: answer.bytes };
    }
    const identity = hashJson(['darwin', answer.dev, ino]);
    if (answer.classification === 'local-fixed') {
        return { classification: 'local-fixed', reason: 'storage-provenance-local-fixed', adapter, binding: 'helper-confirmed', identity, bytes: answer.bytes };
    }
    return {
        classification: answer.classification,
        reason: 'storage-provenance-' + (answer.classification === 'unknown' ? 'undetermined' : answer.classification),
        adapter, binding: 'helper-confirmed', identity, bytes: answer.bytes,
    };
}
/** Windows: `GetVolumePathNameW` binding, drive type, then the hotplug IOCTL. */
function observeWindows(canonical, dev, ino, arch) {
    const adapter = 'windows-volume-hotplug';
    const file = helperPath('win32', arch);
    if (file === null) {
        return { classification: 'unknown', reason: 'storage-provenance-helper-absent', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: 0 };
    }
    const answer = runHelper(file, canonical, 'win32');
    if (answer === null) {
        return { classification: 'unknown', reason: 'storage-provenance-helper-unusable', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: 0 };
    }
    // Windows volume-serial semantics are not established as equal to this runtime's
    // `st_dev`, so a reported identity is only ever used to REFUSE on disagreement,
    // never relaxed into confirmation. See native/task-advisor-storage/README.md.
    if (answer.dev !== null && answer.dev !== String(dev)) {
        return { classification: 'unknown', reason: 'storage-provenance-volume-mismatch', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: answer.bytes };
    }
    // No reported identity means no volume was ever bound to this path, so the verdict
    // describes an unnamed volume. Refusing here is the same rule Darwin already
    // applies; it is required refusal semantics, NOT a claim that Windows fixed-media
    // support is implemented, and it fabricates no identity: the Windows↔Node binding
    // remains unverified and is an open CI gate.
    if (answer.dev === null) {
        return { classification: 'unknown', reason: 'storage-provenance-unbound-volume', adapter, binding: 'node-only', identity: hashJson([dev, ino]), bytes: answer.bytes };
    }
    const binding = 'helper-confirmed';
    const identity = hashJson(['win32', answer.dev, dev, ino]);
    if (answer.classification === 'local-fixed') {
        return { classification: 'local-fixed', reason: 'storage-provenance-local-fixed', adapter, binding, identity, bytes: answer.bytes };
    }
    return {
        classification: answer.classification,
        reason: 'storage-provenance-' + (answer.classification === 'unknown' ? 'undetermined' : answer.classification),
        adapter, binding, identity, bytes: answer.bytes,
    };
}
/** Parse `/proc/self/mountinfo` into the fields ADAPTER-DECISION selects. */
function parseMountinfo(text) {
    const entries = [];
    for (const line of text.split('\n')) {
        if (line.length === 0)
            continue;
        const parts = line.split(' ');
        if (parts.length < 10)
            continue;
        const separator = parts.indexOf('-', 6);
        if (separator < 0 || separator + 2 >= parts.length)
            continue;
        entries.push({
            majorMinor: parts[2],
            mountPoint: unescapeMountField(parts[4]),
            fsType: unescapeMountField(parts[separator + 1]),
            source: unescapeMountField(parts[separator + 2]),
        });
    }
    return entries;
}
/**
 * Decompose a Linux `dev_t` into `major:minor` exactly as glibc does, so the
 * selected `mountinfo` entry can be reconciled with the target's own `st_dev`.
 * Returns null when the value cannot be represented exactly, which refuses.
 */
function linuxDevToMajorMinor(dev) {
    if (!Number.isSafeInteger(dev) || dev < 0)
        return null;
    const value = BigInt(dev);
    const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n);
    const minor = (value & 0xffn) | ((value >> 12n) & 0xffffff00n);
    return `${major}:${minor}`;
}
/**
 * Linux: one unambiguous `mountinfo` match, reconciled against the target's own
 * `st_dev`, plus the selected `sysfs` attributes for that exact device.
 * Classifies `network` and `removable` on positive evidence; it can never return
 * `local-fixed`, because the bounded metadata it may read carries no positive proof
 * of internal media. That leaves Linux unqualifiable by design — see REPORT.md §2.
 */
function observeLinux(canonical, dev) {
    const adapter = 'linux-mountinfo-sysfs';
    const unknown = (reason, bytes) => ({ classification: 'unknown', reason, adapter, binding: 'node-only', identity: hashJson(['linux', reason]), bytes });
    const mountinfo = readBounded('/proc/self/mountinfo', MOUNTINFO_MAX_BYTES);
    let bytes = mountinfo.bytes;
    const covering = parseMountinfo(mountinfo.text).filter(entry => underMountPoint(canonical, entry.mountPoint));
    if (covering.length === 0)
        return unknown('storage-provenance-mount-unresolved', bytes);
    let longest = covering[0];
    for (const entry of covering)
        if (entry.mountPoint.length > longest.mountPoint.length)
            longest = entry;
    // Over-mounts leave two entries at the same point; which one backs the path is
    // not decidable from this table alone, so the sample is refused.
    if (covering.filter(entry => entry.mountPoint.length === longest.mountPoint.length).length !== 1) {
        return unknown('storage-provenance-mount-ambiguous', bytes);
    }
    // A longest-covering-mount string match does not establish that this entry describes
    // the device the target actually sits on; only reconciling it with the target's own
    // `st_dev` does. Every fact below is read from the selected entry, so an unreconciled
    // entry would make the whole observation — including a `mountinfo-matched` label —
    // a claim about some other device. Reconcile first or refuse.
    const targetDevice = linuxDevToMajorMinor(dev);
    if (targetDevice === null)
        return unknown('storage-provenance-device-unreadable', bytes);
    if (targetDevice !== longest.majorMinor)
        return unknown('storage-provenance-device-mismatch', bytes);
    const identity = hashJson(['linux', longest.majorMinor, longest.mountPoint, longest.fsType]);
    const matched = (classification, reason) => ({ classification, reason, adapter, binding: 'mountinfo-matched', identity, bytes });
    if (NETWORK_FILESYSTEMS.has(longest.fsType) || longest.fsType.startsWith('fuse.')
        || (longest.source.includes(':') && !longest.source.startsWith('/'))) {
        return matched('network', 'storage-provenance-network');
    }
    if (!longest.source.startsWith('/dev/'))
        return matched('unknown', 'storage-provenance-non-block-source');
    if (!/^\d+:\d+$/.test(longest.majorMinor) || longest.majorMinor.startsWith('0:')) {
        return matched('unknown', 'storage-provenance-non-block-device');
    }
    let topology;
    try {
        topology = fs.realpathSync.native('/sys/dev/block/' + longest.majorMinor);
    }
    catch {
        return matched('unknown', 'storage-provenance-topology-unavailable');
    }
    if (!topology.startsWith('/sys/devices/'))
        return matched('unknown', 'storage-provenance-topology-unrecognized');
    // Device-mapper, LVM, dm-crypt and md targets resolve under `/sys/devices/virtual/`.
    // Their physical member devices are not reachable from this one bounded lookup, and
    // enumerating them is out of scope, so no hotplug segment appearing here is merely
    // absence of evidence: a mapper stacked on a USB disk resolves to exactly the same
    // virtual node as one on an internal disk, and `removable` below reads `0` for both.
    // Positive proof is unavailable under the approved bounded metadata, so classify
    // unknown rather than infer fixed media from negative tests.
    if (topology.startsWith('/sys/devices/virtual/'))
        return matched('unknown', 'storage-provenance-virtual-topology');
    const lowered = topology.toLowerCase();
    if (HOTPLUG_TRANSPORTS.some(segment => lowered.includes(segment))) {
        return matched('removable', 'storage-provenance-removable');
    }
    // Partitions carry no `removable`; the attribute belongs to the holder disk.
    let holder = topology;
    if (fs.existsSync(path.join(topology, 'partition')))
        holder = path.dirname(topology);
    let removable;
    try {
        const read = readBounded(path.join(holder, 'removable'), SYSFS_MAX_BYTES);
        bytes += read.bytes;
        removable = read.text.trim();
    }
    catch {
        return matched('unknown', 'storage-provenance-removable-unreadable');
    }
    if (removable === '1')
        return matched('removable', 'storage-provenance-removable');
    if (removable !== '0')
        return matched('unknown', 'storage-provenance-removable-ambiguous');
    // `removable == 0` is the last fact this path may read, and an internal disk, a SAN
    // LUN and a virtual disk are indistinguishable through it. Nothing here positively
    // measured internal media, so refuse rather than infer it. See REPORT.md §2.
    return matched('unknown', 'storage-provenance-internal-media-unestablished');
}
/** Facts for a measurement that could not be taken at all. Always `unknown`. */
function unmeasured(reason, adapter, targetPath, canonicalPath, filesystemType, cost) {
    return {
        protocol: STORAGE_PROVENANCE_PROTOCOL, classification: 'unknown', reason, adapter,
        adapterVersion: STORAGE_PROVENANCE_ADAPTER_VERSION, observedAt: new Date().toISOString(),
        platform: process.platform, arch: process.arch, osRelease: os.release(),
        filesystemType, targetPath, canonicalPath, volumeIdentity: hashJson([reason, adapter]),
        volumeBinding: 'node-only', cost,
    };
}
/**
 * Measure the provenance of the medium backing `targetPath`.
 *
 * Never throws: every failure is an `unknown` classification carrying the exact
 * reason, because a measurement stage that throws would be indistinguishable from
 * a crash and might tempt a caller into treating absence of failure as success.
 *
 * The canonical path, device and inode are bound before the OS query and rechecked
 * after it. A symlink swap, remount or device change between the two observations
 * invalidates the sample: the answer would describe a volume that is no longer the
 * one the caller is about to use.
 */
export function measureStorageProvenance(targetPath) {
    const started = performance.now();
    const rssBefore = process.memoryUsage.rss();
    const cost = (bytes) => ({
        wallMs: Math.max(0, Math.round(performance.now() - started)),
        bytesRead: bytes,
        rssBytes: Math.max(0, process.memoryUsage.rss() - rssBefore),
    });
    let canonical = targetPath;
    let filesystemType = 'unknown';
    try {
        canonical = fs.realpathSync.native(targetPath);
        const before = fs.lstatSync(canonical);
        filesystemType = String(fs.statfsSync(canonical).type);
        if (!before.isDirectory())
            return unmeasured('storage-provenance-target-not-directory', 'none', targetPath, canonical, filesystemType, cost(0));
        const observation = process.platform === 'darwin' ? observeDarwin(canonical, before.dev, before.ino, process.arch)
            : process.platform === 'win32' ? observeWindows(canonical, before.dev, before.ino, process.arch)
                : process.platform === 'linux' ? observeLinux(canonical, before.dev)
                    : { classification: 'unknown', reason: 'storage-provenance-unsupported-platform', adapter: 'unsupported-platform', binding: 'node-only', identity: hashJson([process.platform]), bytes: 0 };
        // Re-bind. The observation is only about the volume we measured before it.
        const afterCanonical = fs.realpathSync.native(targetPath);
        const after = fs.lstatSync(afterCanonical);
        const afterType = String(fs.statfsSync(afterCanonical).type);
        const stable = afterCanonical === canonical && after.dev === before.dev
            && after.ino === before.ino && afterType === filesystemType && after.isDirectory();
        const metrics = cost(observation.bytes);
        if (!stable)
            return unmeasured('storage-provenance-target-changed', observation.adapter, targetPath, canonical, filesystemType, metrics);
        if (metrics.wallMs > MAX_WALL_MS)
            return unmeasured('storage-provenance-time-limit', observation.adapter, targetPath, canonical, filesystemType, metrics);
        if (metrics.bytesRead > MAX_BYTES_READ)
            return unmeasured('storage-provenance-byte-limit', observation.adapter, targetPath, canonical, filesystemType, metrics);
        return {
            protocol: STORAGE_PROVENANCE_PROTOCOL, classification: observation.classification, reason: observation.reason,
            adapter: observation.adapter, adapterVersion: STORAGE_PROVENANCE_ADAPTER_VERSION,
            observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: os.release(),
            filesystemType, targetPath, canonicalPath: canonical, volumeIdentity: observation.identity,
            volumeBinding: observation.binding, cost: metrics,
        };
    }
    catch {
        // Denied, vanished, oversize or otherwise unmeasurable. Refuse, never guess.
        return unmeasured('storage-provenance-unmeasurable', 'none', targetPath, canonical, filesystemType, cost(0));
    }
}
/**
 * Structural check for measured provenance facts.
 *
 * The pure matcher and its fixtures must use exactly the shape the production
 * caller produces, so a fixture cannot invent a looser fact. This validates shape
 * only; it can never upgrade a classification or authorize a write.
 */
export function checkStorageProvenance(input) {
    const item = recordV2(input);
    exactKeysV2(item, ['protocol', 'classification', 'reason', 'adapter', 'adapterVersion', 'observedAt',
        'platform', 'arch', 'osRelease', 'filesystemType', 'targetPath', 'canonicalPath',
        'volumeIdentity', 'volumeBinding', 'cost']);
    requireV2(item.protocol === STORAGE_PROVENANCE_PROTOCOL, 'unknown-provenance-protocol');
    requireV2(['local-fixed', 'removable', 'network', 'unknown'].includes(textV2(item.classification)), 'invalid-provenance-class');
    requireV2(['helper-confirmed', 'mountinfo-matched', 'node-only'].includes(textV2(item.volumeBinding)), 'invalid-volume-binding');
    for (const key of ['reason', 'adapter', 'platform', 'arch', 'osRelease', 'filesystemType', 'volumeIdentity'])
        textV2(item[key]);
    for (const key of ['targetPath', 'canonicalPath'])
        textV2(item[key], LIMITS.text);
    uintV2(item.adapterVersion, Number.MAX_SAFE_INTEGER, 1);
    utcV2(item.observedAt);
    const cost = recordV2(item.cost);
    exactKeysV2(cost, ['wallMs', 'bytesRead', 'rssBytes']);
    // Structural VALIDITY only, never eligibility. An over-budget measurement refuses,
    // and the excess is the refusal's whole point, so the refusal facts must carry the
    // true measured values. Bounding these by the very ceilings that produced the
    // refusal made this module reject a refusal it had just emitted, and the matcher
    // reported that throw as `storage-provenance-missing` — a measurement that ran out
    // of budget reached the operator as one never taken. The ceilings are enforced
    // where they belong, as eligibility, by `storageProvenanceBudgetRefusal`.
    // `rssBytes` remains unbounded here: CONTRACT §1 ¶5's RSS bound needs an exact
    // design and evidence decision and is deliberately left OPEN.
    uintV2(cost.wallMs);
    uintV2(cost.bytesRead);
    uintV2(cost.rssBytes);
    return item;
}
/**
 * Eligibility check, separate from the structural validity above: a measurement that
 * exceeded its approved budget can never support a production write, however
 * well-formed its facts are. Returns the exact reason `measureStorageProvenance`
 * itself uses for that overrun, or null when the sample stayed within budget. No
 * measured value is capped or altered to make anything pass.
 */
export function storageProvenanceBudgetRefusal(facts) {
    if (facts.cost.wallMs > MAX_WALL_MS)
        return 'storage-provenance-time-limit';
    if (facts.cost.bytesRead > MAX_BYTES_READ)
        return 'storage-provenance-byte-limit';
    return null;
}
//# sourceMappingURL=storage-provenance.js.map