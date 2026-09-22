// wl1165i-tester / task1165 / release1171 / operation wl1165i-v1
// attempt 8a3cd5d3-f9df-41e3-a067-5f8c50e39c69
//
// =============================================================================
//  Independent Linux filesystem qualification probe for the proposed Workbench
//  export adapter (CONTRACT.md D3 / "Proposed authenticated roundtrip protocol"
//  paragraphs on exclusive creation, collision refusal and journal retention).
//
//  WHAT THIS FILE IS
//    An honest verification harness over the ACTUAL emitted modules
//    workbench-contract.js and workbench-files.js. It does NOT rewrite the
//    source, does NOT install a fake fs, does NOT monkeypatch process.platform
//    and does NOT mock SelectedRoot. Every assertion below observes real
//    syscall behaviour against real files in a private /tmp directory.
//
//  WHERE IT RUNS
//    SelectedRoot.open() requires process.platform === 'linux' and the Linux
//    /proc/self/fd descriptor-reopen capability. On Darwin the Linux cases
//    CANNOT run. They are NOT marked skip() and they are NOT counted as
//    qualified: on a non-Linux host they FAIL LOUDLY with a NOT-RUN message.
//    "Skipped" would read as green; it is not. Only PROBE-01 is meaningful on
//    Darwin, where it asserts the platform refusal itself.
//
//  FIXTURES
//    ../fixtures/workbench-linux/workbench-{contract,files}.js, resolved
//    relative to import.meta.url. No author-machine absolute path appears in
//    this file. The controller stages those exact two compiled modules; their
//    SHA256 provenance is recorded in output/REPORT.md.
//
//  DURABILITY SCOPE
//    PROBE-16 observes the fsync-then-verify API path only. Power-loss
//    durability is UNMEASURED by this harness and is NOT claimed anywhere.
//
//  RUN
//    node --test --test-reporter=tap --test-timeout=3000 \
//         tests/knowledge/workbench-linux-probe.test.mjs
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, link, stat, rename, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const FIXTURES = new URL('../fixtures/workbench-linux/', import.meta.url);
const C = await import(new URL('workbench-contract.js', FIXTURES).href);
const F = await import(new URL('workbench-files.js', FIXTURES).href);

const { SCHEMA, hash } = C;
const { SelectedRoot, preview, publishIncoming } = F;

/** Per-case bound; 16 cases x 3s stays inside the 60s whole-suite budget. */
const CASE = { timeout: 3000 };

const KOR_NFC = '회의록.md'.normalize('NFC');
const KOR_NFD = '회의록.md'.normalize('NFD');

/**
 * Linux-only gate. Throws rather than skipping so a non-Linux run can never be
 * mistaken for a qualified run.
 */
function requireLinuxRunner(probe) {
  if (process.platform !== 'linux') {
    throw new Error(
      `NOT RUN (${probe}): this case requires Linux and the /proc/self/fd capability. ` +
      `Host platform is '${process.platform}'. This is a NOT-RUN failure, not a pass ` +
      `and not a skip; it must not be reported as qualified.`,
    );
  }
}

/**
 * A private synthetic directory under Linux /tmp. Never a vault, never a host
 * path, never the user's own filesystem. Literal '/tmp' rather than TMPDIR so
 * the selected-root component rules are exercised against a known parent.
 */
async function tempRoot() {
  return await mkdtemp('/tmp/wb-linux-probe-');
}

function note(over = {}) {
  return {
    noteId: 'note-1', path: 'Notes.md', baseRevision: 'rev-0', sourceId: 'src-1',
    occurrenceId: 'occ-1', revisionId: 'rev-1', citations: [],
    attribution: { kind: 'authored' }, predecessors: [], ...over,
  };
}

function sel(notes) {
  return {
    schema: SCHEMA, operationId: 'op-1',
    scope: { tenant: 't1', project: 'p1', vaultId: 'v1', purpose: 'sync' }, notes,
  };
}

function bundleOf(...bodies) {
  return {
    files: bodies.map((body, i) => {
      const b64 = body.toString('base64');
      return { noteId: `note-${i + 1}`, hash: hash(body), bytes: b64, baseBytes: b64 };
    }),
  };
}

const isContractRefusal = (e) => {
  assert.equal(e.message, 'invalid-workbench-input',
    `expected the contract refusal, got: ${e && e.code ? e.code + ' ' + e.message : e}`);
  return true;
};

// ---------------------------------------------------------------------------
// PROBE-01 — platform gate. The only case that is meaningful on both hosts.
// ---------------------------------------------------------------------------
test('PROBE-01 platform gate: non-Linux is refused, Linux opens a real root', CASE, async () => {
  if (process.platform !== 'linux') {
    // Darwin path: the refusal is the assertion. This is NOT a Linux
    // qualification; PROBE-02..16 remain NOT RUN.
    await assert.rejects(() => SelectedRoot.open('/tmp'), isContractRefusal);
    return;
  }
  const dir = await tempRoot();
  try {
    const root = await SelectedRoot.open(dir);
    await root.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PROBE-02 — Unicode NFC and NFD are DISTINCT names on a byte-preserving Linux
// filesystem. Neither is normalised, renamed or folded on read.
// ---------------------------------------------------------------------------
test('PROBE-02 NFC and NFD note names read back as separate, unmodified files', CASE, async () => {
  requireLinuxRunner('PROBE-02');
  const dir = await tempRoot();
  try {
    const bodyNfc = Buffer.from('---\ntitle: 회의록 NFC\n---\n\n본문 prose\n', 'utf8');
    const bodyNfd = Buffer.from('---\ntitle: 회의록 NFD\n---\n\n본문 prose\n', 'utf8');
    assert.notEqual(KOR_NFC, KOR_NFD, 'fixture precondition: the two spellings differ');
    await writeFile(join(dir, KOR_NFC), bodyNfc, { mode: 0o600 });
    await writeFile(join(dir, KOR_NFD), bodyNfd, { mode: 0o600 });

    const names = await readdir(dir);
    assert.equal(names.length, 2,
      'precondition: this filesystem must keep NFC and NFD as two distinct entries');

    const root = await SelectedRoot.open(dir);
    try {
      assert.equal(Buffer.compare(await root.read(KOR_NFC), bodyNfc), 0,
        'the NFC name must resolve to the NFC file byte-for-byte');
      assert.equal(Buffer.compare(await root.read(KOR_NFD), bodyNfd), 0,
        'the NFD name must resolve to the NFD file byte-for-byte');
    } finally { await root.close(); }

    // The user's files were neither renamed nor rewritten by the read path.
    assert.equal(Buffer.compare(await readFile(join(dir, KOR_NFC)), bodyNfc), 0);
    assert.equal(Buffer.compare(await readFile(join(dir, KOR_NFD)), bodyNfd), 0);
    assert.deepEqual((await readdir(dir)).sort(), [KOR_NFC, KOR_NFD].sort());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-03 — preview over a real selected root: exact bytes, exact hash,
// original path spelling, generated attribution accepted, stable payloadHash.
// ---------------------------------------------------------------------------
test('PROBE-03 preview returns exact bytes, hash and original spelling', CASE, async () => {
  requireLinuxRunner('PROBE-03');
  const dir = await tempRoot();
  try {
    const body = Buffer.from('# 회의록\n\n본문 — emoji 🎧 tail\n', 'utf8');
    await writeFile(join(dir, KOR_NFD), body, { mode: 0o600 });
    const root = await SelectedRoot.open(dir);
    try {
      const input = sel([note({
        path: KOR_NFD,
        attribution: {
          kind: 'generated', generator: 'gen-1', version: 'v1',
          dependencies: ['rev-0'],
        },
      })]);
      const out = await preview(root, input);

      assert.equal(out.files.length, 1);
      assert.equal(out.files[0].noteId, 'note-1');
      assert.equal(out.files[0].hash, hash(body), 'preview hash is the sha256 of the real bytes');
      assert.equal(Buffer.compare(Buffer.from(out.files[0].bytes, 'base64'), body), 0,
        'preview base64 decodes to the exact on-disk bytes');
      assert.equal(out.notes[0].path, KOR_NFD,
        'the captured NFD spelling survives preview unchanged');
      assert.equal(out.notes[0].attribution.kind, 'generated');
      assert.match(out.payloadHash, /^[a-f0-9]{64}$/);

      // Canonical digest is deterministic for the same selection and bytes.
      const again = await preview(root, input);
      assert.equal(again.payloadHash, out.payloadHash);
    } finally { await root.close(); }
    assert.equal(Buffer.compare(await readFile(join(dir, KOR_NFD)), body), 0,
      'preview is read-only: the user note is untouched');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-04 — malformed UTF-8 is a contract refusal and nothing on disk moves.
// ---------------------------------------------------------------------------
test('PROBE-04 malformed UTF-8 is refused and the file is not repaired', CASE, async () => {
  requireLinuxRunner('PROBE-04');
  const dir = await tempRoot();
  try {
    const bad = Buffer.from([0x68, 0x69, 0xff, 0x0a]);
    const target = join(dir, 'Notes.md');
    await writeFile(target, bad, { mode: 0o600 });
    const before = await stat(target, { bigint: true });

    const root = await SelectedRoot.open(dir);
    try {
      await assert.rejects(() => preview(root, sel([note()])), isContractRefusal);
    } finally { await root.close(); }

    const after = await stat(target, { bigint: true });
    assert.equal(Buffer.compare(await readFile(target), bad), 0,
      'the malformed bytes must survive the refusal unchanged');
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs, 'refusal must not touch mtime');
    assert.equal(after.ino, before.ino, 'refusal must not replace the inode');
    assert.deepEqual(await readdir(dir), ['Notes.md'], 'no repair or quarantine file appeared');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-05 — an unrelated read failure keeps its own identity; it is NOT
// laundered into the generic contract refusal.
// ---------------------------------------------------------------------------
test('PROBE-05 a missing file keeps ENOENT identity through preview', CASE, async () => {
  requireLinuxRunner('PROBE-05');
  const dir = await tempRoot();
  try {
    const root = await SelectedRoot.open(dir);
    try {
      await assert.rejects(() => preview(root, sel([note()])), (e) => {
        assert.equal(e.code, 'ENOENT', 'the real syscall failure must survive');
        assert.notEqual(e.message, 'invalid-workbench-input',
          'ENOENT must not be masked as a contract refusal');
        return true;
      });
    } finally { await root.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-06 — generated incoming publication lands in the destination while the
// private base/incoming bytes are retained in a SEPARATE journal root.
// ---------------------------------------------------------------------------
test('PROBE-06 incoming publication is separate from the retained journal', CASE, async () => {
  requireLinuxRunner('PROBE-06');
  const dest = await tempRoot();
  const jrnl = await tempRoot();
  try {
    const body = Buffer.from('# incoming 회의록\n\n본문\n', 'utf8');
    const destination = await SelectedRoot.open(dest);
    const journal = await SelectedRoot.open(jrnl);
    try {
      const out = await publishIncoming(destination, journal, bundleOf(body));
      assert.equal(out.state, 'published');
      assert.equal(out.files.length, 1);
      assert.equal(out.files[0].state, 'published');
      assert.match(out.files[0].path, /^incoming-[0-9a-f-]{36}-0\.md$/);
      assert.match(out.journal, /^incoming-[0-9a-f-]{36}\.json$/);
    } finally { await destination.close(); await journal.close(); }

    // Destination holds only the new versioned incoming file, byte-exact.
    const destNames = await readdir(dest);
    assert.equal(destNames.length, 1, 'exactly one versioned incoming file was created');
    assert.equal(Buffer.compare(await readFile(join(dest, destNames[0])), body), 0);

    // Journal holds intent + result, in a different directory, and retains the
    // exact incoming/base bytes. CONTRACT.md: "Journals contain private bytes."
    const jrnlNames = (await readdir(jrnl)).sort();
    assert.equal(jrnlNames.length, 2, 'intent and result records are both journaled');
    assert.ok(jrnlNames.some((n) => n.startsWith('incoming-')));
    assert.ok(jrnlNames.some((n) => n.startsWith('result-')));

    const intentName = jrnlNames.find((n) => n.startsWith('incoming-'));
    const intent = JSON.parse(await readFile(join(jrnl, intentName), 'utf8'));
    assert.equal(intent.schema, 1);
    assert.equal(intent.state, 'intent');
    assert.equal(intent.bundle.files[0].bytes, body.toString('base64'),
      'the journal retains the exact incoming bytes');
    assert.equal(intent.bundle.files[0].baseBytes, body.toString('base64'),
      'the journal retains the exact observed base bytes');
    assert.deepEqual(intent.destinations, destNames);

    const resultName = jrnlNames.find((n) => n.startsWith('result-'));
    const result = JSON.parse(await readFile(join(jrnl, resultName), 'utf8'));
    assert.equal(result.retained, intentName);
    assert.equal(result.outcomes[0].state, 'published');

    // No journal record leaked into the destination and no note into the journal.
    assert.equal(destNames.filter((n) => n.endsWith('.json')).length, 0);
    assert.equal(jrnlNames.filter((n) => n.endsWith('.md')).length, 0);
  } finally {
    await rm(dest, { recursive: true, force: true });
    await rm(jrnl, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PROBE-07 — the separate-root constraint is enforced BEFORE anything is
// written, so a same-root call leaves both roots empty.
// ---------------------------------------------------------------------------
test('PROBE-07 destination and journal must be separate roots', CASE, async () => {
  requireLinuxRunner('PROBE-07');
  const dir = await tempRoot();
  try {
    const a = await SelectedRoot.open(dir);
    const b = await SelectedRoot.open(dir); // same dev/ino, opened twice
    try {
      await assert.rejects(
        () => publishIncoming(a, b, bundleOf(Buffer.from('# incoming\n', 'utf8'))),
        isContractRefusal,
      );
      assert.deepEqual(await readdir(dir), [],
        'the constraint is checked before any journal or note is written');
    } finally { await a.close(); await b.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-08 — THE COLLISION CASE. Exclusive creation against a name that already
// exists must refuse, and the pre-existing bytes must be untouched.
//
// This is the assertion the prior NOT-RUN suite claimed but did not make: its
// "refuses to overwrite" case only observed a successful publish and a name
// prefix. Here the destination name is pre-created on purpose, so O_EXCL is
// genuinely exercised.
// ---------------------------------------------------------------------------
test('PROBE-08 create() refuses an existing name and leaves its bytes intact', CASE, async () => {
  requireLinuxRunner('PROBE-08');
  const dir = await tempRoot();
  try {
    const name = 'incoming-fixed-collision-0.md';
    const original = Buffer.from('# the user edited this first\n\n원본 본문\n', 'utf8');
    const target = join(dir, name);
    await writeFile(target, original, { mode: 0o600 });
    const before = await stat(target, { bigint: true });

    const root = await SelectedRoot.open(dir);
    try {
      await assert.rejects(
        () => root.create(name, Buffer.from('# replacement that must never land\n', 'utf8')),
        (e) => {
          assert.equal(e.code, 'EEXIST',
            'exclusive creation must fail with EEXIST, not silently replace');
          return true;
        },
      );
    } finally { await root.close(); }

    const after = await stat(target, { bigint: true });
    assert.equal(Buffer.compare(await readFile(target), original), 0,
      'the existing note keeps the editor bytes exactly');
    assert.equal(after.ino, before.ino, 'no rename-over or replacement occurred');
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(await readdir(dir), [name], 'no partial or temporary file was left behind');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-09 — an existing symlink in the selected root is refused on read; the
// link target is never followed and never read.
// ---------------------------------------------------------------------------
test('PROBE-09 an existing symlink is refused and its target is untouched', CASE, async () => {
  requireLinuxRunner('PROBE-09');
  const dir = await tempRoot();
  const outside = await tempRoot();
  try {
    const secretish = join(outside, 'target.md');
    const secretBytes = Buffer.from('# outside the selected root\n', 'utf8');
    await writeFile(secretish, secretBytes, { mode: 0o600 });
    await symlink(secretish, join(dir, 'Notes.md'));

    const root = await SelectedRoot.open(dir);
    try {
      await assert.rejects(() => root.read('Notes.md'), (e) => {
        assert.equal(e.code, 'ELOOP',
          'O_NOFOLLOW must refuse the symlink rather than follow it out of the root');
        return true;
      });
      // The same refusal must hold through preview.
      await assert.rejects(() => preview(root, sel([note()])), (e) => {
        assert.equal(e.code, 'ELOOP');
        return true;
      });
    } finally { await root.close(); }

    assert.equal(Buffer.compare(await readFile(secretish), secretBytes), 0,
      'the link target was neither read-modified nor replaced');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PROBE-10 — a hardlinked file (nlink > 1) is refused: the adapter will not
// read bytes that a second path can mutate underneath it.
// ---------------------------------------------------------------------------
test('PROBE-10 a hardlinked note is refused as invalid-workbench-input', CASE, async () => {
  requireLinuxRunner('PROBE-10');
  const dir = await tempRoot();
  try {
    const body = Buffer.from('# hardlinked\n', 'utf8');
    await writeFile(join(dir, 'Notes.md'), body, { mode: 0o600 });
    await link(join(dir, 'Notes.md'), join(dir, 'Alias.md'));
    assert.equal((await stat(join(dir, 'Notes.md'), { bigint: true })).nlink, 2n,
      'fixture precondition: the note really has two links');

    const root = await SelectedRoot.open(dir);
    try {
      await assert.rejects(() => root.read('Notes.md'), isContractRefusal);
      await assert.rejects(() => root.read('Alias.md'), isContractRefusal);
      await assert.rejects(() => preview(root, sel([note()])), isContractRefusal);
    } finally { await root.close(); }

    assert.equal(Buffer.compare(await readFile(join(dir, 'Notes.md')), body), 0,
      'the refusal did not rewrite the hardlinked content');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-11 — the root is pinned to the selected INODE, not to its pathname.
// Renaming the selected directory away and moving a different directory into
// its place must neither redirect reads to the replacement nor mutate it.
// ---------------------------------------------------------------------------
test('PROBE-11 a pinned root does not follow a renamed/replaced pathname', CASE, async () => {
  requireLinuxRunner('PROBE-11');
  const parent = await tempRoot();
  try {
    const alpha = join(parent, 'alpha');
    const beta = join(parent, 'beta');
    await mkdir(alpha);
    await mkdir(beta);
    const alphaBytes = Buffer.from('# selected alpha\n', 'utf8');
    const betaBytes = Buffer.from('# unrelated beta\n', 'utf8');
    await writeFile(join(alpha, 'Pinned.md'), alphaBytes, { mode: 0o600 });
    await writeFile(join(beta, 'Pinned.md'), betaBytes, { mode: 0o600 });

    const root = await SelectedRoot.open(alpha);
    try {
      // Swap the pathname out from under the open handle.
      await rename(alpha, join(parent, 'alpha-moved'));
      await rename(beta, alpha);

      const read = await root.read('Pinned.md');
      assert.equal(Buffer.compare(read, alphaBytes), 0,
        'the pinned handle must still read the originally selected directory');
      assert.notEqual(Buffer.compare(read, betaBytes), 0,
        'the pinned handle must NOT escape into the directory now at that path');

      // Writing through the pinned handle must land in the original, not the
      // replacement now occupying the old pathname.
      await root.create('written-by-probe.md', Buffer.from('# written\n', 'utf8'));
    } finally { await root.close(); }

    assert.deepEqual((await readdir(join(parent, 'alpha-moved'))).sort(),
      ['Pinned.md', 'written-by-probe.md'],
      'the write landed in the originally selected inode');
    assert.deepEqual(await readdir(alpha), ['Pinned.md'],
      'the replacement directory gained nothing');
    assert.equal(Buffer.compare(await readFile(join(alpha, 'Pinned.md')), betaBytes), 0,
      'the replacement directory was not mutated');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-12 — selected-root path admission. Traversal, relative, root, device
// and encoded-escape spellings are refused at open() time.
// ---------------------------------------------------------------------------
test('PROBE-12 unsafe selected-root paths are refused at open', CASE, async () => {
  requireLinuxRunner('PROBE-12');
  const dir = await tempRoot();
  try {
    const refused = [
      '/',                       // the filesystem root itself
      'tmp/relative',            // not absolute
      `${dir}/..`,               // traversal component
      `${dir}/.`,                // self component
      `${dir}/a\\b`,             // backslash
      `${dir}/a%2e%2e`,          // percent-encoded escape
      `${dir}/secrets`,          // reserved category
      `${dir}/recordings`,       // reserved category
      `${dir}/.hidden`,          // component may not start with a dot
      `${dir}/has/two/../parts`, // traversal mid-path
    ];
    for (const path of refused) {
      await assert.rejects(() => SelectedRoot.open(path), isContractRefusal,
        `expected refusal for selected root: ${JSON.stringify(path)}`);
    }
    // A NUL byte is refused too; kept separate because it cannot sit in a table
    // comment legibly.
    await assert.rejects(() => SelectedRoot.open(`${dir}/a\0b`), isContractRefusal);

    // Control: an ordinary nested component is accepted, so the table above is
    // measuring the rule and not a blanket failure.
    await mkdir(join(dir, 'ok'));
    const root = await SelectedRoot.open(join(dir, 'ok'));
    await root.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-13 — a short UTF-16 name can still blow the 255-byte component budget.
// ---------------------------------------------------------------------------
test('PROBE-13 an over-byte-budget Korean component is refused at open', CASE, async () => {
  requireLinuxRunner('PROBE-13');
  const dir = await tempRoot();
  try {
    const wide = '회'.repeat(86); // 86 chars, 258 UTF-8 bytes, over the 255 budget
    assert.equal(Buffer.byteLength(wide, 'utf8'), 258, 'fixture precondition');
    await assert.rejects(() => SelectedRoot.open(join(dir, wide)), isContractRefusal);

    const fits = '회'.repeat(85); // 255 bytes exactly
    assert.equal(Buffer.byteLength(fits, 'utf8'), 255, 'fixture precondition');
    await mkdir(join(dir, fits));
    const root = await SelectedRoot.open(join(dir, fits));
    await root.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-14 — read() and create() name admission inside a pinned root.
// ---------------------------------------------------------------------------
test('PROBE-14 unsafe note names are refused by read() and create()', CASE, async () => {
  requireLinuxRunner('PROBE-14');
  const dir = await tempRoot();
  try {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'Inner.md'), Buffer.from('# inner\n', 'utf8'), { mode: 0o600 });
    const root = await SelectedRoot.open(dir);
    try {
      for (const name of ['sub/Inner.md', '../escape.md', '..', '.', '', 'a\0b', '.hidden.md']) {
        await assert.rejects(() => root.read(name), isContractRefusal,
          `read() must refuse ${JSON.stringify(name)}`);
      }
      // read() names are bounded at 201 UTF-16 units.
      await assert.rejects(() => root.read(`${'a'.repeat(199)}.md`), isContractRefusal);

      // create() is deliberately narrower than a user note name: generated
      // destination names only, so non-ASCII is refused here even though a
      // user note may carry it.
      for (const name of ['sub/Gen.md', '회의록.md', '-leading.md', 'a..b.md', '']) {
        await assert.rejects(() => root.create(name, Buffer.from('x', 'utf8')), isContractRefusal,
          `create() must refuse ${JSON.stringify(name)}`);
      }
      assert.deepEqual((await readdir(dir)).sort(), ['sub'],
        'no refused name produced a file');
    } finally { await root.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PROBE-15 — when a destination create genuinely fails, publishIncoming reports
// 'partial' with an identified orphan-or-collision outcome and still journals.
//
// The failure is forced by removing write permission on the destination, which
// is a real EACCES from the kernel, not an injected stub. Running as uid 0
// would defeat that, so this case FAILS with a named gap rather than passing
// vacuously.
// ---------------------------------------------------------------------------
test('PROBE-15 a failed destination create yields partial + identified orphan', CASE, async () => {
  requireLinuxRunner('PROBE-15');
  assert.notEqual(process.getuid(), 0,
    'GAP (PROBE-15): running as uid 0 bypasses directory permissions, so a ' +
    'write-denied destination cannot be staged honestly. Re-run this job as a ' +
    'non-root user; do not record this invariant as verified.');

  const dest = await tempRoot();
  const jrnl = await tempRoot();
  try {
    const body = Buffer.from('# incoming\n', 'utf8');
    const destination = await SelectedRoot.open(dest);
    const journal = await SelectedRoot.open(jrnl);
    try {
      await chmod(dest, 0o500); // readable and traversable, not writable
      const out = await publishIncoming(destination, journal, bundleOf(body));

      assert.equal(out.state, 'partial', 'a failed publication must not be reported published');
      assert.equal(out.files.length, 1);
      assert.equal(out.files[0].state, 'orphan-or-collision',
        'the unpublished destination is explicitly identified');
      assert.match(out.journal, /^incoming-[0-9a-f-]{36}\.json$/);
    } finally {
      await chmod(dest, 0o700);
      await destination.close();
      await journal.close();
    }

    assert.deepEqual(await readdir(dest), [], 'nothing was published into the destination');
    const jrnlNames = await readdir(jrnl);
    assert.equal(jrnlNames.length, 2,
      'the retained intent and the result record both survive a partial publication');
    const intentName = jrnlNames.find((n) => n.startsWith('incoming-'));
    const intent = JSON.parse(await readFile(join(jrnl, intentName), 'utf8'));
    assert.equal(intent.bundle.files[0].bytes, body.toString('base64'),
      'recovery bytes are retained even though publication failed');
  } finally {
    await chmod(dest, 0o700).catch(() => {});
    await rm(dest, { recursive: true, force: true });
    await rm(jrnl, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PROBE-16 — API-OBSERVED write-and-verify only.
//
// create() calls f.sync() and directory.sync() and re-reads the bytes through a
// fresh descriptor before returning. This case observes exactly that: after the
// promise resolves, an independent read returns identical bytes and the entry
// is present in the directory.
//
// IT DOES NOT MEASURE POWER-LOSS DURABILITY. No crash, no power cut, no write
// barrier and no cache-flush behaviour is exercised here, and none is claimed.
// Whether the bytes survive an untimely power loss is UNMEASURED by this
// harness and remains an open acceptance item.
// ---------------------------------------------------------------------------
test('PROBE-16 create() is verified read-back (API-observed, NOT power-loss durable)', CASE, async () => {
  requireLinuxRunner('PROBE-16');
  const dir = await tempRoot();
  try {
    const name = 'incoming-generated-0.md';
    const body = Buffer.from('# generated incoming\n\n본문 🎧\n', 'utf8');
    const root = await SelectedRoot.open(dir);
    try {
      await root.create(name, body);
      // Independent descriptor, not the one create() held.
      assert.equal(Buffer.compare(await readFile(join(dir, name)), body), 0);
      assert.equal(Buffer.compare(await root.read(name), body), 0);
      const st = await stat(join(dir, name), { bigint: true });
      assert.equal(st.nlink, 1n, 'the created file is unlinked from any other path');
      assert.equal(st.size, BigInt(body.length));
      assert.equal(Number(st.mode) & 0o777, 0o600, 'created private, not world-readable');
    } finally { await root.close(); }
    assert.deepEqual(await readdir(dir), [name]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
