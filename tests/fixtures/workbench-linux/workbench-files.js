import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { LIMITS, decode, digest, hash, markdownPath, requireUtf8, requireValue, safeComponent, selection } from './workbench-contract.js';
/** Linux procfs descriptor capability; no realpath/check-then-open fallback. */
export class SelectedRoot {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    static async open(path) {
        requireValue(process.platform === 'linux' && isAbsolute(path) && path !== '/'
            && !path.includes('\\') && !path.includes('%') && !path.includes('\0'));
        const parts = path.slice(1).split('/');
        // Same bounded Unicode component rule as the notes themselves; the captured bytes
        // are opened unchanged, never normalised or renamed.
        requireValue(parts.every(p => safeComponent(p, 255)
            && p !== '.' && p !== '..' && !/^(secrets?|recordings?)$/i.test(p)));
        let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            for (const part of parts) {
                const next = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                await handle.close();
                handle = next;
            }
            // Pin the selected directory inode, not its subsequently mutable pathname.
            return new SelectedRoot(handle);
        }
        catch (error) {
            await handle.close();
            throw error;
        }
    }
    async close() { await this.directory.close(); }
    async assertSeparate(other) {
        const a = await this.directory.stat();
        const b = await other.directory.stat();
        requireValue(a.dev !== b.dev || a.ino !== b.ino);
    }
    async read(name, max = LIMITS.bytes) {
        requireValue(safeComponent(name, 201));
        const f = await open(`/proc/self/fd/${this.directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const before = await f.stat({ bigint: true });
            requireValue(before.isFile() && before.nlink === 1n && before.size <= BigInt(max));
            const bytes = Buffer.alloc(max + 1);
            let count = 0;
            while (count < bytes.length) {
                const result = await f.read(bytes, count, bytes.length - count, count);
                if (!result.bytesRead)
                    break;
                count += result.bytesRead;
            }
            const after = await f.stat({ bigint: true });
            requireValue(count <= max && BigInt(count) === before.size && after.size === before.size
                && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && after.nlink === 1n);
            return bytes.subarray(0, count);
        }
        finally {
            await f.close();
        }
    }
    /** Generated destination names only; deliberately narrower than a user note name. */
    async create(name, bytes) {
        requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) && !name.includes('..'));
        const f = await open(`/proc/self/fd/${this.directory.fd}/${name}`, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await f.writeFile(bytes);
            await f.sync();
            const check = Buffer.alloc(bytes.length);
            let count = 0;
            while (count < check.length) {
                const read = await f.read(check, count, check.length - count, count);
                requireValue(read.bytesRead > 0);
                count += read.bytesRead;
            }
            requireValue(check.equals(bytes) && (await f.stat()).nlink === 1);
            const linked = await this.read(name, Math.max(bytes.length, 1));
            requireValue(linked.equals(bytes));
            await this.directory.sync();
        }
        finally {
            await f.close();
        }
    }
}
export async function preview(root, input) {
    const selected = selection(input);
    let total = 0;
    const files = [];
    for (const note of selected.notes) {
        markdownPath(note.path);
        const bytes = await root.read(note.path);
        requireUtf8(bytes);
        total += bytes.length;
        requireValue(total <= LIMITS.total);
        files.push({ noteId: note.noteId, hash: hash(bytes), bytes: bytes.toString('base64') });
    }
    const payload = { ...selected, files };
    return { ...payload, payloadHash: digest(payload) };
}
/** Never deletes, repairs or overwrites even a partial file. Journals contain private bytes. */
export async function publishIncoming(destination, journal, bundle) {
    await destination.assertSeparate(journal);
    requireValue(bundle.files.length > 0 && bundle.files.length <= LIMITS.files);
    let total = 0;
    for (const file of bundle.files) {
        const incoming = decode(file.bytes);
        const base = decode(file.baseBytes);
        requireValue(hash(incoming) === file.hash);
        total += incoming.length + base.length;
        requireValue(total <= LIMITS.total);
    }
    const batch = randomUUID();
    const retained = `incoming-${batch}.json`;
    const files = bundle.files.map((f, i) => ({ path: `incoming-${batch}-${i}.md`, bytes: decode(f.bytes) }));
    // Durable intent contains exact base/incoming bytes and portable provenance before any publication.
    await journal.create(retained, Buffer.from(JSON.stringify({ schema: 1, bundle,
        destinations: files.map(f => f.path), state: 'intent' })));
    const outcomes = [];
    for (const file of files) {
        try {
            await destination.create(file.path, file.bytes);
            outcomes.push({ path: file.path, state: 'published' });
        }
        catch {
            outcomes.push({ path: file.path, state: 'orphan-or-collision' });
        }
    }
    let state = outcomes.every(f => f.state === 'published') ? 'published' : 'partial';
    try {
        await journal.create(`result-${batch}.json`, Buffer.from(JSON.stringify({ retained, outcomes })));
    }
    catch {
        state = 'partial';
    }
    return { state, journal: retained, files: outcomes };
}
//# sourceMappingURL=workbench-files.js.map