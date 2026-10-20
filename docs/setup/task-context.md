# Task context source checkpoint

Dispatch accepts the optional pair `--context-manifest FILE --context-sha256 HASH`.
Both must be present; duplicate options and unknown options retain the shared
parser's existing refusal behavior. HASH is lowercase SHA256. Help tails retain
their previous semantics. With neither option, dispatch follows its existing
route, deduplication and unknown-delivery/retry behavior; its context evidence is
**legacy_unverified**. No additional legacy output or task writes are introduced.

The strict production path currently refuses with `ENV_TASK_CONTEXT_REFUSED`
and diagnostic `source_cut_unverified` **before dispatch initialization**.
The controller source-cut, measured provider admission and context-aware registry
ports are unavailable. There is no environment flag, manifest field or CLI
bypass that installs them. This is an incomplete source checkpoint, not a
working strict dispatch feature or task1163 completion.

## Manifest and source bytes

`src/task-context/contract.ts` defines `aigentry-task-context/1`. Every declared
field is required, including explicit nulls; unknown fields and versions refuse.
Serialization uses sorted object keys, UTF-8 JSON and one final LF. Record arrays
must follow parent-topological order, required before optional, source-local
order, then stable ID; optional independent records use rank then ID.
Duplicate JSON keys, lone surrogate escapes and invalid UTF-8 refuse.
Metadata is canonicalized; original payloads are never normalized or trimmed.

The manifest carries task/release/controller/SID/attempt/scope and context/project
partition identity; generation/predecessor/cut; controller selection revision,
bound original request record IDs, ingress cursors, gaps and attestations;
source revision/digest/size/schema/adapter/provenance; records and typed causal
edges; state links, exact commit/tree/dirty-artifact identities; enumeration,
required coverage and separate delivery fields.

`basis.request_ids` and `current_request_id` name record IDs. Each request record
has a distinct original occurrence ID. Equal text is not deduplicated.
Every state link and bound request must be required. All requirement IDs must
have a required record. Parents and typed edge targets must exist and be required
when referenced by required records. Cycles, ambiguous selection, missing state
and unknown enumeration refuse. Complete enumeration is a controller assertion
about the declared scope, never a claim of global source completeness.

The supported extraction schema is `utf8-byte-range/1` with a
`raw-bytes/1` source adapter. Start is inclusive; end is exclusive. The reader
checks the full original envelope digest and preserves the complete selected
text range with extraction provenance. Binary renderers and JSON-pointer
adapters are not implemented; required unsupported payloads refuse. Approvals,
denials and revocations remain evidence, with permission provenance and explicit
nullable expiry. They cannot grant execution. Current permission must be checked
by the controller/provider admission owner; unknown expiry is not perpetual.

Manifest locator IDs select from controller-supplied `ReadGrant` objects. They
are not paths or authority. The manifest file, original dispatch ref and sources
all require external grants. `scopedReader` rejects path escape, case-folded
collisions, unsupported no-follow protection, symlinks and nonregular files,
and checks ancestors plus fd identity, bounded bytes, size and digest before
returning content. Ancestor rechecks are not an atomic directory-handle walk or
cross-store transaction. A protected controller namespace and authoritative cut
are still required. Native Windows reader support is explicitly unavailable.

## Materialization and admission

Source caps are128 records,32 dependency tasks,depth8,1MiB manifest,8MiB combined
source/ref reads,64KiB required text item,128KiB full required envelope and16KiB
optional sections. Metadata and coverage consume body capacity. Required content
is never summarized or truncated. Optional sections are whole or omitted with
an explicit reason; unsupported or unavailable optional sources are not silently
claimed present.

Length-delimited sections contain exact raw text, record provenance and byte
spans. Embedded delimiters in text do not change the length framing. All text
remains evidence rather than executable permission. The original dispatch ref
is included without placeholder substitution in strict mode; the controller
must supply a resolved ref. To prevent duplicating the current request in that
ref, composition conservatively refuses when its exact nonempty text is already
present. It never deletes either copy automatically.

The caller's source branch stages the manifest and full assembled ref using the
existing content-addressed worker ref mechanism, then prepares metadata-only
binding arguments. The1170 report trailer remains last. The transport message
stays exactly `[context-ref] Read <path> and use it as the source of truth for this task.`
No fallible context file I/O follows registry commit before inject. These
positive staging branches are not production-reachable with the unavailable
ports; the registry owner must implement and validate their contract first.

Measured provider byte capacity must account for role/system/tool reservations.
The provider port must admit the exact final bytes, attempt and version through
an input-observation-gated route. Merely having capacity or returning a receipt
does not prove consumption. `materialized`, transport observation, report
custody/review and effective provider input remain separate. No code in this
checkpoint reports `input_verified`.

Two matching source reads cannot supply an authoritative cross-store cut.
Existing writer owners must supply selection/cut receipts and validate them
under the registry transaction along with predecessor/attempt/scope and provider
admission. A lost commit response, unknown transport or unobserved provider input
does not authorize automatic replay or ownership transfer.

## Verification still owed

The two new test modules exercise the real shared parser and dispatchMain's
early refusal, pure assembly/composition, and explicitly simulated ports.
They do not establish provider, installed, native or registry success.
The existing runner discovers their compiled `.test.js` files automatically.
Author execution is limited to one compile; tests/runtime/scanner are NOTRUN.

Root security disposition, original U1 registry integration, independent tests,
source-cut admission, provider consumption and installed/native verification
remain mandatory.1166 U3/U4–U6,1201 boot,1204 compact,1170 semantic ACK,
1217–1221 account/device acceptance and all release holds remain open.
