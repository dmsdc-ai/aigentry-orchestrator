import test from "node:test";
import assert from "node:assert/strict";
import { assembleManifest, composeContextRef } from "../../src/task-context/assemble.js";
import { canonicalBytes, parseManifest, sha256, ContextRefusal, LIMITS,
  type ContextManifest, type Selection, type ContextPorts, type RefusalCode } from "../../src/task-context/contract.js";

// All ports/receipts below are simulations. No provider or transport is contacted.
function fixture(text = "원문 e\u0301\r\nkeep exact bytes\n") {
  const bytes = Buffer.from(text), ref = Buffer.from("Assignment reference, without repeating the request.");
  const identity: ContextManifest["identity"] = {
    task_id: "1163", release_group: "release-1238", version: "0.3.0", controller_binding_id: "sim-binding",
    sid: "sim-worker", attempt: "sim-attempt", scope_sha256: "1".repeat(64), context_id: "sim-context",
    project_id: "sim-project", partition: { mode: "local-only", namespace: "sim-local", account_id: null },
  };
  const m: ContextManifest = {
    schema: "aigentry-task-context/1", identity,
    revision: { generation: 0, parent_sha256: null, source_cut: "sim-cut", assembler: "1", created_at: "2026-10-19" },
    basis: { selection_revision: "sim-selection", requirement_ids: ["R1"], request_ids: ["r1"],
      current_request_id: "r1", ingress: "sim-ingress", cursor_start: "1", cursor_end: "1", gaps: [], owner_attestations: ["sim-attestation"] },
    sources: [{ id: "s1", store: "simulation", logical_ref: "sim-receipt", revision: "1", sha256: sha256(bytes),
      bytes: bytes.length, schema: "sim-envelope/1", adapter: "raw-bytes/1", locator_id: "g1", observed_at: "2026-10-19", quality: "declared-snapshot" }],
    records: [{ id: "r1", kind: "request", occurrence_id: "occurrence-1", source_id: "s1",
      extraction: { schema: "utf8-byte-range/1", start: 0, end: bytes.length }, text_sha256: sha256(bytes),
      parents: [], scope: identity.context_id, requirement_ids: ["R1"], authority: "user-evidence",
      permission: null, required: true, reason: "bound original", rank: 0, source_order: 0 }],
    state: { links: { goals: ["r1"], constraints: [], decisions: [], approvals: [], denials: [], reports: [],
      owners: [], operations: [], results: [], checkpoints: [], blockers: [], next_actions: [] },
      dependency_tasks: [], source_commit: "a".repeat(40), source_tree: "b".repeat(40), dirty_artifacts: [] },
    closure: { selected_ids: ["r1"], edges: [], exclusions: [], issues: [],
      enumeration: { complete: true, source_count: 1, record_count: 1, receipt: "sim-enumeration" } },
    coverage: { expected_required_ids: ["r1"], expected_required_count: 1 },
    delivery: { original_ref_sha256: sha256(ref), body_sha256: null, body_bytes: null,
      dispatch_id: null, final_ref_sha256: null, observed_input_receipt: null },
  };
  const selection: Selection = {
    identity, manifest: { logical_id: "manifest", root: "/simulation", relative: "manifest", revision: "1", sha256: "0".repeat(64), bytes: 0 },
    original_ref: { logical_id: "ref", root: "/simulation", relative: "ref", revision: "1", sha256: sha256(ref), bytes: ref.length },
    sources: [{ logical_id: "g1", root: "/simulation", relative: "source", revision: "1", sha256: sha256(bytes), bytes: bytes.length }],
    selection_revision: "sim-selection", source_cut: "sim-cut", required_ids: ["r1"], current_request_id: "r1",
  };
  return { m, selection, bytes, ref };
}
const code = (wanted: RefusalCode) => (e: unknown): boolean => e instanceof ContextRefusal && e.diagnostic.code === wanted;

test("raw originals retain Unicode normalization, CRLF, full length and reconstructable spans", () => {
  const f = fixture(), a = assembleManifest(f.m, f.selection, () => f.bytes);
  const span = a.spans[0]!;
  assert.deepEqual(a.body.subarray(span.start, span.end), f.bytes);
  assert.equal(span.sha256, sha256(f.bytes));
  assert.equal(a.status.input_observation, "unobserved");
  assert.equal(a.status.completeness, "declared-closure");
});

test("strict parser rejects unknown fields, escaped duplicate keys, invalid Unicode and noncanonical JSON", () => {
  const { m } = fixture();
  for (const raw of [
    Buffer.from('{"schema":"a","\\u0073chema":"b"}\n'),
    Buffer.from('{"schema":"\\ud800"}\n'),
    Buffer.from([0xff]), canonicalBytes({ ...m, surprise: true }), Buffer.from(JSON.stringify(m)),
  ]) assert.throws(() => parseManifest(raw, sha256(raw)), code("manifest_invalid"));
  const bytes = canonicalBytes(m);
  assert.deepEqual(parseManifest(bytes, sha256(bytes)), m);
  assert.throws(() => parseManifest(bytes, "0".repeat(64)), code("source_changed"));
});

test("equal text from distinct request occurrences is retained; causal order wins", () => {
  const f = fixture();
  f.m.records.push({ ...f.m.records[0]!, id: "r2", occurrence_id: "occurrence-2", source_order: 1, parents: ["r1"] });
  f.m.basis.request_ids.push("r2");
  f.m.basis.current_request_id = "r2"; f.selection.current_request_id = "r2";
  f.m.closure.selected_ids.push("r2"); f.m.closure.enumeration.record_count = 2;
  f.m.coverage.expected_required_ids.push("r2"); f.m.coverage.expected_required_count = 2;
  f.selection.required_ids.push("r2");
  const a = assembleManifest(f.m, f.selection, () => f.bytes);
  assert.deepEqual(a.spans.map(s => s.id), ["r1", "r2"]);
  for (const span of a.spans) assert.deepEqual(a.body.subarray(span.start, span.end), f.bytes);
  f.m.records[1]!.occurrence_id = "occurrence-1";
  assert.throws(() => assembleManifest(f.m, f.selection, () => f.bytes), code("closure_conflict"));
});

test("missing required closure, dependency cycles and incomplete enumeration refuse before reads", () => {
  for (const change of [
    (m: ContextManifest) => { m.records[0]!.parents = ["absent"]; },
    (m: ContextManifest) => { m.closure.edges.push({ from: "r1", to: "r1", kind: "revokes" }); },
    (m: ContextManifest) => { m.closure.enumeration.complete = false; },
    (m: ContextManifest) => { m.state.links.denials = ["absent"]; },
    (m: ContextManifest) => { m.basis.gaps = ["missing receipt"]; },
  ]) {
    const f = fixture(); change(f.m);
    let reads = 0;
    assert.throws(() => assembleManifest(f.m, f.selection, () => { reads++; return f.bytes; }), ContextRefusal);
    assert.equal(reads, 0);
  }
});

test("source digest, extraction boundaries and required byte budgets cannot silently truncate", () => {
  const f = fixture();
  assert.throws(() => assembleManifest(f.m, f.selection, () => Buffer.from("changed")), code("source_changed"));
  f.m.records[0]!.extraction.end++;
  assert.throws(() => assembleManifest(f.m, f.selection, () => f.bytes), code("manifest_invalid"));
  const large = fixture("가".repeat(Math.floor(LIMITS.requiredItemBytes / 3) + 1));
  assert.throws(() => assembleManifest(large.m, large.selection, () => large.bytes), code("required_context_overflow"));
  const binary = fixture(); binary.m.records[0]!.extraction.schema = "binary/1";
  assert.throws(() => assembleManifest(binary.m, binary.selection, () => binary.bytes), code("unsupported_required_payload"));
});

test("mixed identity and controller selection mismatches refuse without source reads", () => {
  const f = fixture();
  const selection = structuredClone(f.selection); selection.identity.partition.namespace = "different";
  assert.throws(() => assembleManifest(f.m, selection, () => assert.fail("must not read")), code("identity_mismatch"));
  selection.identity = f.m.identity; selection.required_ids = [];
  assert.throws(() => assembleManifest(f.m, selection, () => assert.fail("must not read")), code("coverage_unknown"));
});

test("optional omission is explicit and does not remove a required original", () => {
  const f = fixture();
  f.m.records.push({ ...f.m.records[0]!, id: "optional", occurrence_id: "optional-occurrence",
    required: false, source_order: 1, extraction: { schema: "binary/1", start: 0, end: f.bytes.length } });
  f.m.closure.selected_ids.push("optional"); f.m.closure.enumeration.record_count++;
  const a = assembleManifest(f.m, f.selection, () => f.bytes);
  assert.deepEqual(a.omitted_optional, [{ id: "optional", reason: "unsupported_payload" }]);
  assert.deepEqual(a.spans.map(s => s.id), ["r1"]);
});

test("depth and full required-body caps refuse without summarizing required records", () => {
  for (const [count, text] of [[9, "Original"], [3, "x".repeat(60000)]] as const) {
    const f = fixture(text);
    for (let i = 2; i <= count; i++) {
      const id = `r${i}`;
      f.m.records.push({ ...f.m.records[0]!, id, occurrence_id: `occurrence-${i}`,
        source_order: i - 1, parents: [`r${i - 1}`] });
      f.m.closure.selected_ids.push(id); f.m.coverage.expected_required_ids.push(id);
      f.selection.required_ids.push(id);
    }
    f.m.closure.enumeration.record_count = count; f.m.coverage.expected_required_count = count;
    assert.throws(() => assembleManifest(f.m, f.selection, () => f.bytes), code("required_context_overflow"));
  }
});

test("simulated final composition binds exact attempt, final trailer and input-gated admission", () => {
  const f = fixture(), assembly = assembleManifest(f.m, f.selection, () => f.bytes);
  const calls: string[] = [];
  const ports: ContextPorts = {
    authority: { select: () => f.selection, validateCut: (_s, phase) => {
      calls.push(phase); return { source_cut: "sim-cut", selection_revision: "sim-selection", receipt: "sim-cut-receipt" };
    } },
    provider: { capacity: { receipt: "sim-capacity", provider: "simulation", version: "1", available_bytes: 1024 * 1024 },
      admit: (body, selection) => { calls.push("simulated-admission"); return { receipt: "sim-input-gate", body_sha256: sha256(body),
        attempt: selection.identity.attempt, input_status: "awaiting-observation", route: "input-gated" }; } },
    registry: { schema: "aigentry-context-binding/1" },
  };
  const raw = canonicalBytes(f.m);
  const prepared = { manifest: f.m, manifestBytes: raw, originalRef: f.ref, manifestSha256: sha256(raw),
    selection: f.selection, assembly, ports, cutReceipt: "sim-preflight" };
  const trailer = "\n<!-- aigentry-report v1 -->\nREPORT_ENVELOPE simulation-only\n";
  const result = composeContextRef(prepared, f.ref, trailer, { attempt: "sim-attempt", hash: f.m.identity.scope_sha256 });
  assert.equal(result.bytes.subarray(-Buffer.byteLength(trailer)).toString(), trailer);
  assert.equal(result.binding.final_ref_sha256, sha256(result.bytes));
  assert.equal(result.binding.input_observation, "unobserved");
  assert.deepEqual(calls, ["simulated-admission", "before-binding"]);
  assert.throws(() => composeContextRef(prepared, f.ref, trailer, { attempt: "stale", hash: f.m.identity.scope_sha256 }), code("attempt_changed"));
  ports.authority!.validateCut = () => ({ source_cut: "new-cut", selection_revision: "sim-selection", receipt: "sim-change" });
  assert.throws(() => composeContextRef(prepared, f.ref, trailer, { attempt: "sim-attempt", hash: f.m.identity.scope_sha256 }), code("source_cut_changed"));
});

test("local port simulation refuses a preexisting stale final cut before provider admission", () => {
  const setup = (finalCut: string) => {
    const f = fixture(), assembly = assembleManifest(f.m, f.selection, () => f.bytes);
    let admitCalls = 0;
    const phases: string[] = [];
    const ports: ContextPorts = {
      authority: { select: () => f.selection, validateCut: (_selection, phase) => {
        phases.push(phase);
        return { source_cut: finalCut, selection_revision: f.selection.selection_revision, receipt: "sim-final-cut" };
      } },
      provider: { capacity: { receipt: "sim-capacity", provider: "simulation", version: "1", available_bytes: 1024 * 1024 },
        admit: (body, selection) => {
          admitCalls++;
          return { receipt: "sim-input-gate", body_sha256: sha256(body), attempt: selection.identity.attempt,
            input_status: "awaiting-observation", route: "input-gated" };
        } },
      registry: { schema: "aigentry-context-binding/1" },
    };
    const raw = canonicalBytes(f.m);
    const prepared = { manifest: f.m, manifestBytes: raw, originalRef: f.ref, manifestSha256: sha256(raw),
      selection: f.selection, assembly, ports, cutReceipt: "sim-preflight" };
    const trailer = "\n<!-- aigentry-report v1 -->\nREPORT_ENVELOPE simulation-only\n";
    return { compose: () => composeContextRef(prepared, f.ref, trailer,
      { attempt: f.m.identity.attempt, hash: f.m.identity.scope_sha256 }),
      admissionCount: () => admitCalls, phases };
  };

  const valid = setup("sim-cut");
  const composed = valid.compose();
  assert.equal(composed.binding.final_ref_sha256, sha256(composed.bytes));
  assert.equal(composed.binding.source_cut, "sim-cut");
  assert.equal(valid.admissionCount(), 1);
  assert.deepEqual(valid.phases, ["before-binding"]);

  // Fresh fixture: the final cut is already stale, independent of admission.
  const stale = setup("sim-known-stale-cut");
  assert.throws(() => stale.compose(), code("source_cut_changed"));
  assert.deepEqual(stale.phases, ["before-binding"]);
  assert.equal(stale.admissionCount(), 0);
});
