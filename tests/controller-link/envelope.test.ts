// Task 1291 — controller-link v1 envelope codec (SPEC §3), TEST-PLAN §2.1 E1–E8.
// Pure: every case builds its input in memory; the only file read is the module's own source
// (the purity check at the end), located the way tests/dispatch/submit-policy-439.test.ts does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  BODY_MAX_BYTES, CTL_END_MARKER, CTL_LINE2, CTL_VERSION_MARKER, ENVELOPE_MAX_BYTES, FIELD_ORDER, INGEST_MAX_BLOCKS,
  INGEST_MAX_BYTES, normaliseBody, parseEnvelope, renderEnvelope, scanInput,
  type BodyResult, type Envelope, type EnvelopeFields, type EnvelopeKind, type EnvelopeResult, type ScannedBlock,
} from "../../src/controller-link/envelope.js";

const ID = "3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f";
const idN = (n: number): string => `3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e${n.toString(16).padStart(2, "0")}`;
const SENT = "2026-11-22T10:00:00Z";
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const MULTI = "가나다 — café ünïcode 🙂\n\tindented line kept\n\nafter an inner empty line";

function base(kind: EnvelopeKind, id = ID): EnvelopeFields {
  const common = { id, sent_at: SENT, sender_task: "1291", outcome: null, final: null, reason: null } as const;
  switch (kind) {
    case "REQUEST": return { ...common, kind, seq: 1, ref: null, from: "mac", to: "linux", receiver_task: null, state: null };
    case "ACK": return { ...common, kind, seq: 2, ref: "REQUEST-1", from: "linux", to: "mac", receiver_task: "2026112102", state: "accepted" };
    case "PROBE": return { ...common, kind, seq: 1, ref: "REPLY-1", from: "mac", to: "linux", receiver_task: "2026112102", state: null };
    case "REPLY": return { ...common, kind, seq: 1, ref: null, from: "linux", to: "mac", receiver_task: "2026112102", state: null, outcome: "done", final: "yes" };
  }
}

const code = (r: EnvelopeResult | BodyResult): string => (r.ok ? "OK" : r.error.code);

function must(r: EnvelopeResult): Envelope {
  if (!r.ok) assert.fail(`expected an envelope, got ${r.error.code}: ${r.error.detail}`);
  return r.envelope;
}

function scan(input: string | Uint8Array): { blocks: ScannedBlock[]; dropped_blocks: number; ignored_lines: number } {
  const r = scanInput(input);
  if (!r.ok) assert.fail(`scan refused: ${r.error.code}: ${r.error.detail}`);
  return r;
}

/** Rewrites the header's space-separated `name=value` tokens; nothing else changes. */
function withTokens(text: string, edit: (t: string[]) => string[]): string {
  const lines = text.split("\n");
  lines[0] = `${CTL_VERSION_MARKER} ${edit(lines[0]!.slice(CTL_VERSION_MARKER.length + 1).split(" ")).join(" ")}`;
  return lines.join("\n");
}
const setField = (text: string, name: string, value: string): string =>
  withTokens(text, (t) => t.map((x) => (x.startsWith(`${name}=`) ? `${name}=${value}` : x)));

const KINDS: readonly EnvelopeKind[] = ["REQUEST", "ACK", "PROBE", "REPLY"];

// ---------------------------------------------------------------- E1
test("E1 render→parse→render is identity for every kind, empty and multi-byte bodies", () => {
  for (const kind of KINDS) {
    const bodies = kind === "ACK" || kind === "PROBE" ? [""] : ["", MULTI];
    for (const body of bodies) {
      const a = must(renderEnvelope(base(kind), body));
      const b = must(parseEnvelope(a.text));
      assert.deepEqual(b, a, `${kind} body=${JSON.stringify(body.slice(0, 8))}`);
      assert.equal(must(renderEnvelope(b.fields, b.body)).text, a.text);
      assert.equal(a.body_sha256, sha(body));
      assert.equal(a.body_bytes, Buffer.byteLength(body, "utf8"));
      assert.equal(a.sha256, sha(a.text));
      assert.equal(a.bytes, Buffer.byteLength(a.text, "utf8"));
      assert.ok(!a.text.endsWith("\n") && !a.text.includes("\r"), "LF only, no trailing newline");
    }
  }
  const req = must(renderEnvelope(base("REQUEST"), MULTI));
  assert.deepEqual(req.text.split("\n"), [
    `⟦aigentry-ctl v1⟧ kind=REQUEST id=${ID} seq=1 ref=- from=mac to=linux sent_at=${SENT} sender_task=1291 receiver_task=- ` +
      `state=- outcome=- final=- reason=- body_sha256=${sha(MULTI)} body_bytes=${Buffer.byteLength(MULTI, "utf8")}`,
    CTL_LINE2, "⟦body⟧", ...MULTI.split("\n"), "⟦/body⟧", `⟦aigentry-ctl end⟧ id=${ID} kind=REQUEST seq=1`,
  ]);
  const ack = must(renderEnvelope({ ...base("ACK"), state: "refused", reason: "registration_bypass_requested" }, ""));
  assert.deepEqual(ack.text.split("\n").slice(2), ["⟦body⟧", "⟦/body⟧", `⟦aigentry-ctl end⟧ id=${ID} kind=ACK seq=2`]);
  assert.equal(must(parseEnvelope(ack.text)).fields.reason, "registration_bypass_requested");
  assert.equal(ack.body_sha256, sha(""));
  // Uint8Array bodies (the sender's --ref bytes) render the same as their decoded text.
  assert.equal(must(renderEnvelope(base("REQUEST"), new TextEncoder().encode(MULTI))).text, req.text);
});

// ---------------------------------------------------------------- E2
test("E2 each of the 15 fields: wrong order, missing, extra, out of domain → ENVELOPE_INVALID", () => {
  const texts: Record<EnvelopeKind, string> = {
    REQUEST: must(renderEnvelope(base("REQUEST"), "hello")).text,
    ACK: must(renderEnvelope({ ...base("ACK"), state: "refused", reason: "out_of_policy" }, "")).text,
    PROBE: must(renderEnvelope(base("PROBE"), "")).text,
    REPLY: must(renderEnvelope(base("REPLY"), "done text")).text,
  };
  const t = texts.REQUEST;
  assert.equal(FIELD_ORDER.length, 15);
  FIELD_ORDER.forEach((name, i) => {
    const j = i === 14 ? 13 : i + 1;
    const swapped = withTokens(t, (x) => { const y = [...x]; [y[i], y[j]] = [y[j]!, y[i]!]; return y; });
    assert.equal(code(parseEnvelope(swapped)), "ENVELOPE_INVALID", `order ${name}`);
    assert.equal(code(parseEnvelope(withTokens(t, (x) => x.filter((_, k) => k !== i)))), "ENVELOPE_INVALID", `missing ${name}`);
    assert.equal(code(parseEnvelope(withTokens(t, (x) => [...x.slice(0, i + 1), x[i]!, ...x.slice(i + 1)]))), "ENVELOPE_INVALID", `duplicate ${name}`);
    assert.equal(code(parseEnvelope(withTokens(t, (x) => x.map((v, k) => (k === i ? v.replace("=", ":") : v))))), "ENVELOPE_INVALID", `no = in ${name}`);
  });
  assert.equal(code(parseEnvelope(withTokens(t, (x) => [...x, "extra=1"]))), "ENVELOPE_INVALID", "16th field");
  assert.equal(code(parseEnvelope(withTokens(t, (x) => ["note=hi", ...x]))), "ENVELOPE_INVALID", "unknown leading field");
  assert.equal(code(parseEnvelope(t.replace(" kind=", "  kind="))), "ENVELOPE_INVALID", "two spaces");

  const bad: readonly (readonly [string, EnvelopeKind, readonly string[]])[] = [
    ["kind", "REQUEST", ["NOTICE", "request", "-", ""]],
    ["id", "REQUEST", ["not-a-uuid", ID.toUpperCase(), "3f2b8c1e-9a4d-1c2b-8e1f-0a1b2c3d4e5f", "3f2b8c1e-9a4d-4c2b-7e1f-0a1b2c3d4e5f", "-"]],
    ["seq", "ACK", ["0", "10000", "01", "x", "-", "1.0"]],
    ["ref", "ACK", ["REQUEST-2", "REPLY-0", "REPLY-33", "REPLY-01", "-", "ACK-1"]],
    ["from", "REQUEST", ["Mac", "1mac", "a".repeat(33), "mac_box", "-"]],
    ["to", "REQUEST", ["Linux", "-linux", "b".repeat(33), "-"]],
    ["sent_at", "REQUEST", ["2026-11-22T10:00:00.000Z", "2026-02-30T00:00:00Z", "2026-11-22T24:00:00Z", "2026-11-22T10:00:00+00:00", "-"]],
    ["sender_task", "REQUEST", ["-x", "a".repeat(65), "a/b", "..\\x", "_x"]],
    ["receiver_task", "REQUEST", ["-x", "a".repeat(65), "a/b", ".x"]],
    ["state", "ACK", ["closed", "Received", "-"]],
    ["outcome", "REPLY", ["ok", "Done", "-"]],
    ["final", "REPLY", ["true", "Yes", "-"]],
    ["reason", "ACK", ["because", "Cannot_do", "-"]],
    ["body_sha256", "REQUEST", [sha("hello").toUpperCase(), sha("hello").slice(1), "-"]],
    ["body_bytes", "REQUEST", ["12289", "-1", "05", "x", "-"]],
  ];
  for (const [name, kind, values] of bad) {
    for (const v of values) {
      const r = parseEnvelope(setField(texts[kind], name, v));
      assert.equal(code(r), "ENVELOPE_INVALID", `${kind} ${name}=${v}`);
    }
  }
  // The renderer applies the same domain check to the values it is handed.
  assert.equal(code(renderEnvelope({ ...base("REQUEST"), from: "Mac" }, "x")), "ENVELOPE_INVALID");
  assert.equal(code(renderEnvelope({ ...base("REQUEST"), sender_task: "a b" }, "x")), "ENVELOPE_INVALID");
  assert.equal(code(renderEnvelope({ ...base("ACK"), seq: 10000 }, "")), "ENVELOPE_INVALID");
  assert.equal(code(renderEnvelope({ ...base("ACK"), seq: 1.5 }, "")), "ENVELOPE_INVALID");
  // Structure around the header.
  const lines = t.split("\n");
  assert.equal(code(parseEnvelope([lines[0], "other line 2", ...lines.slice(2)].join("\n"))), "ENVELOPE_INVALID", "line 2");
  assert.equal(code(parseEnvelope([...lines.slice(0, 2), ...lines.slice(3)].join("\n"))), "ENVELOPE_INVALID", "no ⟦body⟧");
  assert.equal(code(parseEnvelope([...lines.slice(0, -2), lines.at(-1)].join("\n"))), "ENVELOPE_INVALID", "no ⟦/body⟧");
  assert.equal(code(parseEnvelope([...lines.slice(0, -1), `${CTL_END_MARKER} id=${idN(1)} kind=REQUEST seq=1`].join("\n"))), "ENVELOPE_INVALID", "end id");
  assert.equal(code(parseEnvelope([...lines.slice(0, -1), `${CTL_END_MARKER} id=${ID} kind=REPLY seq=1`].join("\n"))), "ENVELOPE_INVALID", "end kind");
});

// ---------------------------------------------------------------- E3
test("E3 kind/field fit: ACK with body, PROBE with state, REPLY without final, REQUEST seq≠1 → invalid", () => {
  const ack = must(renderEnvelope(base("ACK"), "")).text;
  const ackLines = ack.split("\n");
  assert.equal(code(renderEnvelope(base("ACK"), "a body")), "ENVELOPE_INVALID", "render ACK with body");
  assert.equal(code(renderEnvelope(base("PROBE"), "a body")), "ENVELOPE_INVALID", "render PROBE with body");
  assert.equal(code(parseEnvelope([...ackLines.slice(0, 3), "smuggled", ...ackLines.slice(3)].join("\n"))), "ENVELOPE_INVALID", "parse ACK with body");
  assert.equal(code(parseEnvelope(setField(ack, "body_bytes", "1"))), "ENVELOPE_INVALID", "ACK body_bytes 1");

  const probe = must(renderEnvelope(base("PROBE"), "")).text;
  assert.equal(code(parseEnvelope(setField(probe, "state", "received"))), "ENVELOPE_INVALID", "PROBE with state");
  assert.equal(code(renderEnvelope({ ...base("PROBE"), state: "received" }, "")), "ENVELOPE_INVALID");
  assert.equal(code(parseEnvelope(setField(probe, "ref", "-"))), "ENVELOPE_INVALID", "PROBE without ref");

  const reply = must(renderEnvelope(base("REPLY"), "x")).text;
  assert.equal(code(parseEnvelope(setField(reply, "final", "-"))), "ENVELOPE_INVALID", "REPLY without final");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), final: null }, "x")), "ENVELOPE_INVALID");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), outcome: null }, "x")), "ENVELOPE_INVALID", "REPLY without outcome");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), seq: 33 }, "x")), "ENVELOPE_INVALID", "REPLY seq 33");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), seq: 32 }, "x")), "OK", "REPLY seq 32");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), ref: "REQUEST-1" }, "x")), "ENVELOPE_INVALID", "REPLY with ref");
  assert.equal(code(renderEnvelope({ ...base("REPLY"), state: "received" }, "x")), "ENVELOPE_INVALID", "REPLY with state");

  const req = must(renderEnvelope(base("REQUEST"), "x")).text;
  assert.equal(code(parseEnvelope(setField(req, "seq", "2"))), "ENVELOPE_INVALID", "REQUEST seq 2");
  assert.equal(code(renderEnvelope({ ...base("REQUEST"), seq: 2 }, "x")), "ENVELOPE_INVALID");
  assert.equal(code(renderEnvelope({ ...base("REQUEST"), ref: "REQUEST-1" }, "x")), "ENVELOPE_INVALID", "REQUEST with ref");
  assert.equal(code(renderEnvelope({ ...base("REQUEST"), outcome: "done" }, "x")), "ENVELOPE_INVALID", "REQUEST with outcome");

  assert.equal(code(renderEnvelope({ ...base("ACK"), state: "refused" }, "")), "ENVELOPE_INVALID", "ACK refused without reason");
  assert.equal(code(renderEnvelope({ ...base("ACK"), reason: "cannot_do" }, "")), "ENVELOPE_INVALID", "ACK accepted with reason");
  assert.equal(code(renderEnvelope({ ...base("ACK"), ref: null }, "")), "ENVELOPE_INVALID", "ACK without ref");
  assert.equal(code(renderEnvelope({ ...base("ACK"), final: "yes" }, "")), "ENVELOPE_INVALID", "ACK with final");
  assert.equal(code(renderEnvelope({ ...base("ACK"), seq: 9999, ref: "REPLY-32", state: "refused", reason: "cannot_do" }, "")), "OK");
});

// ---------------------------------------------------------------- E4
test("E4 body normalisation: line endings, trailing blanks, edge empty lines → one sha; forbidden code points refused by line", () => {
  const canonical = "line one\n\n  indented two\nthree";
  const variants = [
    canonical,
    "line one\r\n\r\n  indented two\r\nthree\r\n",
    "line one\r\r  indented two\rthree",
    "line one  \t\n \t\n  indented two\t\nthree   ",
    "\n\n \t \r\nline one\n\n  indented two\nthree\n\n\t\n",
  ];
  for (const v of variants) {
    for (const input of [v, new TextEncoder().encode(v)]) {
      const r = normaliseBody(input);
      if (!r.ok) assert.fail(`${JSON.stringify(v)}: ${r.error.detail}`);
      assert.equal(r.body, canonical);
      assert.equal(r.sha256, sha(canonical));
      assert.equal(must(renderEnvelope(base("REQUEST"), input)).body_sha256, sha(canonical));
    }
  }
  const empty = normaliseBody(" \r\n\t\n\n");
  assert.ok(empty.ok && empty.body === "" && empty.sha256 === sha("") && empty.bytes === 0);
  assert.ok(normaliseBody("tab\tinside is kept").ok);

  const forbidden = [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f,
    0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x27e6, 0x27e7];
  for (const cp of forbidden) {
    const body = `\n\nfirst\nsecond\nbad ${String.fromCodePoint(cp)} here\nlast`;
    const r = normaliseBody(body);
    assert.equal(code(r), "PEER_BODY_INVALID", `U+${cp.toString(16)}`);
    assert.equal(r.ok ? null : r.error.line, 3, `U+${cp.toString(16)} names normalised line 3`);
    const rr = renderEnvelope(base("REQUEST"), body);
    assert.equal(code(rr), "PEER_BODY_INVALID");
    assert.equal(rr.ok ? null : rr.error.line, 3);
  }
  for (const ok of [0x09, 0xa0, 0x2027, 0x202f, 0x2065, 0x206a, 0x27e5, 0x27e8, 0xfeff]) {
    assert.ok(normaliseBody(`a${String.fromCodePoint(ok)}b`).ok, `U+${ok.toString(16)} allowed`);
  }
  assert.equal(code(normaliseBody(new Uint8Array([0x61, 0xff, 0x62]))), "PEER_BODY_INVALID", "invalid UTF-8");
  assert.equal(code(normaliseBody("a\ud800b")), "PEER_BODY_INVALID", "lone surrogate");
  // A received block whose body carries a forbidden character is not an envelope.
  const lines = must(renderEnvelope(base("REQUEST"), "first\nsecond")).text.split("\n");
  lines[4] = "sec\u202eond";
  const pr = parseEnvelope(lines.join("\n"));
  assert.equal(code(pr), "ENVELOPE_INVALID");
  assert.equal(pr.ok ? null : pr.error.line, 2);
});

// ---------------------------------------------------------------- E5
/** Windows CreateProcess command-line quoting (MSVCRT rules, as cross-spawn applies to a native .exe). */
function winQuote(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

test("E5 caps: body 12288/12289, envelope 16384/16385, largest envelope fits a Windows command line", () => {
  assert.equal(BODY_MAX_BYTES, 12288);
  assert.equal(ENVELOPE_MAX_BYTES, 16384);
  for (const body of ["a".repeat(12288), "가".repeat(4096), `${"x".repeat(100)}\n`.repeat(121) + "y".repeat(67)]) {
    const r = normaliseBody(body);
    if (!r.ok) assert.fail(r.error.detail);
    assert.equal(r.bytes, 12288);
    assert.equal(Buffer.byteLength(r.body, "utf8"), 12288);
    assert.equal(code(renderEnvelope(base("REQUEST"), body)), "OK");
  }
  for (const body of ["a".repeat(12289), "가".repeat(4096) + "a", "🙂".repeat(3073)]) {
    assert.equal(code(normaliseBody(body)), "PEER_BODY_TOO_LARGE");
    assert.equal(code(renderEnvelope(base("REPLY"), body)), "PEER_BODY_TOO_LARGE");
  }
  // Trailing blanks do not count: they are stripped before measuring.
  assert.equal(code(normaliseBody(`${"a".repeat(12288)}   \n\n`)), "OK");

  // Largest legal envelope: every field at its longest, body at its cap.
  const widest: EnvelopeFields = {
    ...base("REPLY"), seq: 32, from: `a${"-".repeat(31)}`, to: `z${"9".repeat(31)}`,
    sender_task: "T".repeat(64), receiver_task: "R".repeat(64), outcome: "declined", final: "yes",
  };
  const worstBodies = ['"'.repeat(12288), '\\"'.repeat(6144), "\\".repeat(12288), "a".repeat(12288)];
  for (const body of worstBodies) {
    const env = must(renderEnvelope(widest, body));
    assert.ok(env.bytes <= ENVELOPE_MAX_BYTES, `largest legal envelope ${env.bytes} bytes`);
    assert.ok(env.text.length <= ENVELOPE_MAX_BYTES, "UTF-16 units ≤ bytes");
    const argv = [
      `C:\\${"p".repeat(255)}\\telepty.exe`, "inject", "--submit", "--no-submit-force", "--submit-retry", "0",
      "--from", "controller-link", `${"s".repeat(128)}@${"h".repeat(253)}`, env.text,
    ];
    const cmdline = argv.map(winQuote).join(" ");
    // lpCommandLine holds at most 32767 UTF-16 units including its terminating NUL.
    assert.ok(cmdline.length + 1 <= 32767, `command line ${cmdline.length} UTF-16 units`);
  }

  // A received block over 16384 bytes is refused for its size before anything else; at 16384 it is not.
  const big = must(renderEnvelope(widest, "a".repeat(12288))).text.split("\n");
  const pad = (target: number): string => {
    const lines = [...big];
    lines[3] = lines[3]! + "a".repeat(target - Buffer.byteLength(big.join("\n"), "utf8"));
    const t = lines.join("\n");
    assert.equal(Buffer.byteLength(t, "utf8"), target);
    return t;
  };
  const at = parseEnvelope(pad(16384));
  const over = parseEnvelope(pad(16385));
  assert.equal(code(at), "ENVELOPE_INVALID");
  assert.ok(!at.ok && !/limit 16384/.test(at.error.detail), "16384 bytes is not refused for envelope size");
  assert.ok(!over.ok && /envelope is 16385 bytes, limit 16384/.test(over.error.detail), "16385 bytes refused for envelope size");
});

// ---------------------------------------------------------------- E6
test("E6 recognition: banner ignored and counted, blocks in order, at most eight, a block needs its end line", () => {
  const req = must(renderEnvelope(base("REQUEST"), "hello\nkind=ACK state=accepted id=" + idN(9))).text;
  const ack = must(renderEnvelope(base("ACK"), "")).text;
  const banner = "📡 [telepty] message from controller-link via peer mac\nsecond banner line\n\n";

  const one = scan(banner + req + "\n");
  assert.equal(one.blocks.length, 1);
  assert.equal(one.ignored_lines, 2);
  assert.equal(one.dropped_blocks, 0);
  assert.equal(one.blocks[0]!.start_line, 4);
  const e = must(one.blocks[0]!.result);
  assert.equal(e.text, req);
  assert.equal(e.fields.kind, "REQUEST", "body text is never read as fields");
  assert.equal(e.fields.state, null);
  assert.equal(e.fields.id, ID);

  const two = scan(`${banner}${req}\ntext between\n${ack}`);
  assert.deepEqual(two.blocks.map((b) => must(b.result).fields.kind), ["REQUEST", "ACK"]);
  assert.equal(two.ignored_lines, 3);

  const nine = Array.from({ length: 9 }, (_, i) => must(renderEnvelope(base("REQUEST", idN(i)), `request ${i}`)).text);
  const many = scan(nine.join("\n"));
  assert.equal(INGEST_MAX_BLOCKS, 8);
  assert.equal(many.blocks.length, 8);
  assert.equal(many.dropped_blocks, 1);
  assert.deepEqual(many.blocks.map((b) => must(b.result).fields.id), nine.slice(0, 8).map((_, i) => idN(i)));

  const truncated = req.split("\n").slice(0, -1).join("\n");
  assert.deepEqual(scan(truncated).blocks, [], "no end line → not a block");
  assert.equal(scan(truncated).ignored_lines, truncated.split("\n").length);
  const thenValid = scan(`${truncated}\n${ack}`);
  assert.equal(thenValid.blocks.length, 1);
  assert.equal(must(thenValid.blocks[0]!.result).fields.kind, "ACK");
  assert.equal(thenValid.ignored_lines, truncated.split("\n").length);

  // An end line without a start, or an end marker alone, is outside text.
  assert.deepEqual(scan(`${CTL_END_MARKER} id=${ID} kind=REQUEST seq=1\nplain`).blocks, []);
  // Input limits.
  assert.equal(INGEST_MAX_BYTES, 262144);
  const fill = (n: number): string => `${req}\n${"x".repeat(n - Buffer.byteLength(req, "utf8") - 1)}`;
  assert.equal(scan(fill(262144)).blocks.length, 1);
  const tooBig = scanInput(new TextEncoder().encode(fill(262145)));
  assert.ok(!tooBig.ok && tooBig.error.code === "INPUT_TOO_LARGE");
  const notUtf8 = scanInput(new Uint8Array([0x61, 0xc3, 0x28]));
  assert.ok(!notUtf8.ok && notUtf8.error.code === "ENVELOPE_INVALID");
});

// ---------------------------------------------------------------- E7
test("E7 copy errors: one changed body character → COPY_MISMATCH; whitespace-only changes accepted", () => {
  const orig = must(renderEnvelope(base("REPLY"), "first line\nsecond — line 🙂"));
  const lines = orig.text.split("\n");

  const changed = [...lines];
  changed[3] = "first linf";
  assert.equal(code(parseEnvelope(changed.join("\n"))), "COPY_MISMATCH");
  const changedMb = [...lines];
  changedMb[4] = "second — line 🙃";
  assert.equal(code(parseEnvelope(changedMb.join("\n"))), "COPY_MISMATCH");
  assert.equal(code(scan(changed.join("\n")).blocks[0]!.result), "COPY_MISMATCH");
  assert.equal(code(parseEnvelope(setField(orig.text, "body_sha256", sha("other")))), "COPY_MISMATCH", "wrong sha");
  assert.equal(code(parseEnvelope(setField(orig.text, "body_bytes", String(orig.body_bytes + 1)))), "COPY_MISMATCH", "wrong length");
  const extraEmpty = [...lines.slice(0, 3), "", ...lines.slice(3)];
  assert.equal(code(parseEnvelope(extraEmpty.join("\n"))), "COPY_MISMATCH", "extra empty body line is not canonical");

  const crlfBlank = `${lines.map((l) => `${l} \t`).join("\r\n")}\r\n`;
  const lone = lines.join("\r");
  for (const variant of [crlfBlank, lone, `${orig.text}\n`]) {
    const viaScan = scan(variant);
    assert.equal(viaScan.blocks.length, 1);
    const e = must(viaScan.blocks[0]!.result);
    assert.equal(e.text, orig.text);
    assert.equal(e.sha256, orig.sha256);
    assert.deepEqual(must(parseEnvelope(variant.replace(/\r?\n$/, ""))), orig);
  }
});

// ---------------------------------------------------------------- E8
test("E8 a marker of another version → VERSION_UNSUPPORTED, never parsed as v1", () => {
  const v1 = must(renderEnvelope(base("REQUEST"), "hello")).text;
  for (const v of ["2", "0", "10", "01", ""]) {
    const other = v1.replace(CTL_VERSION_MARKER, `⟦aigentry-ctl v${v}⟧`);
    assert.equal(code(parseEnvelope(other)), "VERSION_UNSUPPORTED", `v${v}`);
    const s = scan(`banner\n${other}`);
    assert.equal(s.blocks.length, 1);
    assert.equal(code(s.blocks[0]!.result), "VERSION_UNSUPPORTED");
  }
  const mixed = scan(`${v1.replace(CTL_VERSION_MARKER, "⟦aigentry-ctl v2⟧")}\n${v1}`);
  assert.deepEqual(mixed.blocks.map((b) => code(b.result)), ["VERSION_UNSUPPORTED", "OK"]);
});

// ---------------------------------------------------------------- unit constraint: pure
test("envelope.ts is pure: imports node:crypto only; no clock, process, file or network access", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../../src/controller-link/envelope.ts"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto"]);
  assert.doesNotMatch(src, /\b(?:Date\.now|process\.|require\(|import\(|fetch\(|setTimeout|setInterval|Math\.random|randomUUID|readFile|writeFile)/);
});
