// Task 1201 — SPEC §5 / §9.2 "Redaction": one planted string per §5 pattern becomes
// `‹redacted:…›`, a bare sha256 survives, control characters are stripped, and the byproduct
// task note contributes only its last ` || ` segment, ≤ 200 B.
//
// Secret-shaped values are ASSEMBLED AT RUNTIME from fragments, so no file in this repo holds a
// literal that a secret scanner would flag. None of them is a real credential.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { at, dropBox, makeBox, parseHandoff, plantClaude, runCli } from "./harness.js";

const rep = (c: string, n: number): string => c.repeat(n);
const SHA = "9f2c" + rep("0", 56) + "beef";

/** [label, planted text, the substring that must NOT survive]. One row per SPEC §5 pattern. */
const ROWS: readonly (readonly [string, string, string])[] = [
  ["telepty", "x-telepty-token: " + "TPT" + "valueQ1", "TPTvalueQ1"],
  ["authorization", "Authorization: " + "AUTHvalQ2" + "zz", "AUTHvalQ2zz"],
  // The header as it is actually written. A literal `(authorization|bearer)\s*[:=]?\s*\S+`
  // consumes the word "Bearer" as the value and leaves the token itself in clear text.
  ["authorization-bearer", "Authorization: Bearer " + "ABvalQ17" + "zz", "ABvalQ17zz"],
  ["bearer", "bearer " + "BRRvalQ3" + "zz", "BRRvalQ3zz"],
  ["api-key", "api_key=" + "APIKvalQ4", "APIKvalQ4"],
  ["password", "password: " + "PWvalQ5" + "zz", "PWvalQ5zz"],
  ["client-secret", "client_secret=" + "CSvalQ6", "CSvalQ6"],
  ["sk", "sk-" + "Q7" + rep("a", 20), "Q7" + rep("a", 20)],
  ["sk-ant", "sk-" + "ant-" + "Q8" + rep("b", 20), "Q8" + rep("b", 20)],
  ["ghp", "gh" + "p_" + "Q9" + rep("C", 22), "Q9" + rep("C", 22)],
  ["github-pat", "github" + "_pat_" + "Q10" + rep("d", 22), "Q10" + rep("d", 22)],
  ["slack", "xo" + "xb-" + "Q11" + rep("1", 12), "Q11" + rep("1", 12)],
  ["aws", "AK" + "IA" + "Q12" + rep("Z", 13), "Q12" + rep("Z", 13)],
  ["google", "AI" + "za" + "Q13" + rep("e", 32), "Q13" + rep("e", 32)],
  ["jwt", "ey" + "JhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiJRMTQifQ" + ".Q14sig" + "nature", "Q14signature"],
  ["pem", "-----BEGIN " + "RSA PRIVATE KEY-----\nQ15" + rep("k", 40) + "\n-----END " + "RSA PRIVATE KEY-----", "Q15" + rep("k", 40)],
  ["url-userinfo", "https://deploy:" + "Q16pass" + "@example.invalid/x", "Q16pass"],
];

function transcript(requests: readonly string[]): string {
  const rows = requests.map((text, i) =>
    JSON.stringify({
      type: "user", cwd: "__WORKSPACE__", sessionId: "__SESSION__", isSidechain: false,
      timestamp: new Date(Date.UTC(2026, 9, 9, 1, i)).toISOString(), uuid: `r${i}`,
      origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text },
    }),
  );
  rows.push(JSON.stringify({
    type: "assistant", cwd: "__WORKSPACE__", sessionId: "__SESSION__", isSidechain: false,
    timestamp: new Date(Date.UTC(2026, 9, 9, 1, requests.length)).toISOString(), uuid: "a0",
    message: { id: "m", role: "assistant", content: [{ type: "text", text: `status ${ROWS[0][1]} and ${ROWS[6][1]}` }] },
  }));
  return rows.join("\n") + "\n";
}

test("every SPEC §5 pattern is redacted to ‹redacted:…›; a bare sha256 survives", (t) => {
  // ≤ 8 request items survive the window, so the rows are packed several per request.
  const reqs: string[] = [];
  for (let i = 0; i < ROWS.length; i += 3) {
    reqs.push(`R${i} ` + ROWS.slice(i, i + 3).map((r) => r[1]).join(" ; "));
  }
  reqs.push(`evidence sha256 ${SHA} kept`);
  assert.ok(reqs.length <= 8);
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10), text: transcript(reqs) });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  for (const [label, , secret] of ROWS) {
    assert.ok(!r.stdout.includes(secret), `${label}: '${secret}' survived redaction:\n${r.stdout}`);
  }
  const marks = r.stdout.match(/‹redacted:[^›]*›/g) ?? [];
  assert.ok(marks.length >= ROWS.length, `expected ≥ ${ROWS.length} ‹redacted:kind› marks, got ${marks.length}:\n${r.stdout}`);
  assert.ok(r.stdout.includes(SHA), "a bare 64-hex sha256 is evidence and is kept");
});

test("control characters other than newline are stripped from copied text", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10), text: transcript(["bell\u0007 esc\u001b[31m nul\u0000 del\u007f CH-CTRL-DONE"]) });
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("CH-CTRL-DONE"));
  for (const ch of ["\u0007", "\u001b", "\u0000", "\u007f", "\r", "\t"]) {
    assert.ok(!r.stdout.includes(ch), `control U+${ch.codePointAt(0)!.toString(16).padStart(4, "0")} survived`);
  }
});

test("a 112,760-char task note (task 1166's size) contributes only its last segment, ≤ 200 B (SPEC §4.3)", (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10) });
  // 108 dated segments joined by " || ", as the real note is; only the LAST may be used.
  const last = `2026-10-09 CH-NOTE-LAST ${"z".repeat(1000)}`;
  const older: string[] = [];
  for (let i = 0; i < 107; i++) older.push(`2026-09-${String(1 + (i % 28)).padStart(2, "0")} CH-NOTE-OLD-${i} ${"o".repeat(1000)}`);
  const pad = 112_760 - (older.join(" || ").length + " || ".length + last.length);
  assert.ok(pad >= 0);
  older[0] += "o".repeat(pad);
  const note = [...older, last].join(" || ");
  assert.equal(note.length, 112_760);
  fs.writeFileSync(path.join(b.ws, "state", "task-queue.json"), JSON.stringify({
    tasks: [
      { id: 1166, status: "in_progress", priority: "P1", desc: "CH-TASK-1166 capture work", note },
      { id: 9001, status: "done", priority: "P2", desc: "CANARY-DONE-TASK finished work", note: "x" },
    ],
  }));
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const by = (parseHandoff(r.stdout).body.byproduct ?? []).join("\n");
  assert.ok(by.includes("CH-TASK-1166"), `open task listed in Byproduct context:\n${r.stdout}`);
  assert.ok(r.stdout.includes("CH-NOTE-LAST"), "the latest note segment is used");
  assert.doesNotMatch(r.stdout, /CH-NOTE-OLD-/, "an older note segment leaked");
  assert.doesNotMatch(r.stdout, /CANARY-DONE-TASK/, "only in_progress | pending | blocked tasks are listed");
  // The last segment is 1,000+ bytes; ≤ 200 B of it may reach the handoff.
  const zs = Math.max(0, ...(r.stdout.match(/z+/g) ?? []).map((s) => s.length));
  assert.ok(zs <= 200, `the note segment was not cut to ≤ 200 B (${zs} bytes of it survived)`);
});
