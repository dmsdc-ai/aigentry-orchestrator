// session-comms-auditor — orchestrator-side PEER-LANE auditor (#533 Phase 1),
// ported from bin/session-comms-auditor.sh by #899 tranche 4 (ca899).
//
// ADR/spec: docs/adr/2026-06-07-session-comms-guardrail.md
//           docs/superpowers/specs/2026-06-07-session-comms-guardrail.md §4
// Disposition (every measurement cited below):
//           docs/reports/2026-08-17-899-t4-comms-auditor-disposition.md
//
// One audit pass over the new bytes of telepty's peer-inject log. Runs on the
// existing reconcile tick (src/reconciler/cli.ts:1292-1293, step 0c — no new
// daemon, §1 경량), classifies each non-orchestrator↔non-orchestrator inject with
// the structural envelope predicate (§2.3 — whitelist, NOT NLP), reconciles the
// round counter for in-policy raw injects, and escalates the rest as an
// orchestrator HOLD. Warn-mode: the log is never consumed or cleared, and nothing
// is blocked in-band (the inject already happened). Daemon hard-block is Phase 2,
// telepty#18.
//
// THE ONE python3 HEREDOC (bash :56-194) and the one `python3 -c` (:42) became this
// file: regex, JSON, the byte cursor and the clock are the auditor's OWN logic, so
// python3 stops being a dependency of this script entirely (nothing keeps it
// transitively — there is no .py child here, unlike the scheduler's
// dispatch-registry.py). `telepty inject` stays a subprocess with identical argv.
//
// WHAT CHANGED, and what was measured for it (Rule 38). The disposition's §7 has
// the reproductions; the orchestrator's GO fixed D1 as a fix and D2/D3 as below.
//
//   D1 FIXED — one untrusted log line used to disable this guardrail PERMANENTLY.
//      Measured on the original bash: a line that is valid JSON but not an object
//      (`json.loads` succeeds, so the `try/except` written to skip bad lines never
//      fires, and `rec.get` raises one line later) or an envelope whose
//      `thread_id` contains `/` (the state path was built from it unvalidated,
//      `bash :135`) killed the python pass with a traceback. `holds=$(…)` then
//      failed under `set -e` BEFORE the cursor was written, so three consecutive
//      ticks produced `rc=1 cursor=ABSENT` and: every later peer inject went
//      unaudited forever, the pre-poison violation re-injected the SAME HOLD into
//      the orchestrator inbox every 60s, and src/reconciler/cli.ts:1293 folded it
//      all into one `ERR comms-auditor non-zero (continuing)` line. One inject was
//      enough to buy an unaudited peer lane.
//      Now: each record is classified inside its own try/catch — an unexpected
//      throw emits `peer_audit_record_skipped` and the pass continues — and the
//      CURSOR STILL ADVANCES. A `thread_id` containing `/`, or equal to `.`/`..`,
//      is refused by inPolicy() as malformed, so it is escalated as the
//      out-of-policy envelope it is AND the state path can no longer leave
//      SESSION_COMMS_DIR (it was a path-traversal vector into state/session-comms).
//      Contract rows 1-30 and 32-36 are byte-unchanged; rows 31 and 34 become
//      rc 0 plus a recorded skip / a HOLD. tests/dispatch/T122 blocks K and L.
//
//   D2 REPRODUCED — an empty `from` or `to` garbles the HOLD's own fields. The
//      python printed `HOLD\t<from>\t<to>\t<excerpt>` and bash read it back with
//      `IFS=$'\t' read -r`; tab is an IFS *whitespace* character, so runs of tabs
//      COLLAPSE and four fields arrive as two — the HOLD then names the excerpt as
//      the sender (`from: orphan body | to:  | excerpt:`), while the telemetry line
//      stays correct. Reproduced deliberately, collapse and all (holdFields()
//      below): the HOLD wire text is this script's contract with a human reader,
//      and no record shape telepty writes lacks `from`/`to`. T122 block M pins the
//      garbled text verbatim.
//
//   D3 DEVIATION — the bash `fcntl.flock` is NOT reproduced, because it was
//      measured DECORATIVE. 3/3 identical runs: a peer writer holding the lock for
//      2s and this auditor ticking 0.5s in, one `rounds += 1` each, ends at
//      `rounds: 1` — not 2 — with the peer's whole write gone. It waits (1.53s)
//      and excludes nothing, because `os.replace` swaps the INODE the lock is held
//      on, so the waiter is queued on the orphaned file and reads pre-increment
//      content. bin/ask.sh:196-248 is the same shape. Node core has no flock(2)
//      either (src/session/persistence/index-lock.ts:1-6 is the repo's Article 17
//      precedent), and a CORRECT sidecar lock added here alone would exclude
//      concurrent auditor passes (there is one tick at a time: nothing) while
//      still not excluding ask.sh — a real lock on one side of a two-writer race
//      buys zero and reads like a fix. So: tmp + rename, no lock, same observable
//      bytes and the same narrow lost-update window. The two-writer fix is the
//      orchestrator's own ticket (ask.sh + auditor together, index-lock.ts pattern).
//
//   D4 DEVIATION — the excerpt of a NON-STRING body. python rendered `str(body)`,
//      i.e. `{'kind': 'ask-request'}` for an object. JS cannot reproduce that class
//      in general: JSON.parse collapses `1.0` and `1`, so `str()`'s `"1.0"` is
//      unrecoverable, and faking dict/`True`/`None` while silently missing floats
//      would be a worse lie than one documented line. String bodies — the only
//      shape telepty's log is known to write, and the shape both existing guards
//      and 34 of 36 contract rows exercise — are byte-identical. A non-string body
//      renders JSON-style (`{"kind":"ask-request"}`). Same root cause, one more
//      consequence: a JSON `"round": 1.0` was OUT of policy under python
//      (`isinstance(1.0, int)` is False) and is IN policy here. Nothing emits a
//      float round — bin/ask.sh writes an int.
//
//   CURSOR/READ WINDOW — the bash took `os.path.getsize()` and then read to the
//      real EOF, so lines appended in between were audited but not covered by the
//      cursor it wrote, and were re-flagged on the next tick. Here the pass
//      consumes exactly the bytes the cursor will claim (`subarray(start, size)`),
//      which is what that code intended; no measured row changes.
//
// Article 17 (무의존): node stdlib + telepty. No npm runtime deps, no python3.
// Rule 26: ZERO platform branches — the bash had no `uname`/`os_type` arm to
// enumerate (`grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg|sw_vers'` matched
// nothing), and every primitive here behaves the same on macOS and Linux.
//
// NO usage.ts, and no --help. Measured: this script reads NO argv at all —
// `grep -nE '\$[1-9]|\$@|\$\*|\$#|getopts|case "\$'` over the bash matched
// nothing, and `--help` / `bogus --x` each ran a full audit pass (contract rows
// 15-16). There is no --help surface to move, and inventing one would be a
// contract change Rule 29 does not license. Every sibling port has a usage.ts
// because every sibling had a `usage()`; this one did not.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

// SCRIPT_DIR / REPO_DIR were `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` and
// `$SCRIPT_DIR/..`. The shim exports SCRIPT_DIR so a symlinked entrypoint still
// resolves, and — load-bearing here — so that a control workspace audits its OWN
// state/: `init` copies bin/ out of the package and leaves dist/ behind, so a
// REPO_DIR derived from this file's location would point at the PACKAGE root.
// tests/dispatch/T123 pins that. The fallback keeps a direct
// `node dist/src/comms-auditor/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const TELEPTY = env.TELEPTY || "telepty";
const SESSION_COMMS_DIR = env.SESSION_COMMS_DIR || path.join(REPO_DIR, "state/session-comms");
const TELE = path.join(SESSION_COMMS_DIR, "telemetry.jsonl");
const CURSOR = path.join(SESSION_COMMS_DIR, ".audit-cursor");
const PEER_INJECT_LOG =
  env.AIGENTRY_PEER_INJECT_LOG || path.join(REPO_DIR, "state/dispatch/peer-injects.jsonl");
const RAW_ROUND_CAP = env.PEER_ROUND_CAP || "3";
const ORCH_SIDS = env.AIGENTRY_ORCHESTRATOR_SIDS || "orchestrator aigentry-orchestrator-claude";

/** `now_iso()`: AUDITOR_NOW verbatim, else `isoformat(timespec="seconds")` + Z. */
function nowIso(): string {
  if (env.AUDITOR_NOW) return env.AUDITOR_NOW;
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * `int(os.environ["CAP"])` — a non-numeric PEER_ROUND_CAP was a python ValueError
 * and exit 1 before anything was written, and still is. Narrower than python's
 * `int()` on garbage only (`1_000` and non-ASCII digit forms are refused); nothing
 * emits either.
 */
function roundCap(): number {
  if (!/^\s*[+-]?\d+\s*$/.test(RAW_ROUND_CAP)) {
    console.error(`session-comms-auditor: PEER_ROUND_CAP expects an integer, got '${RAW_ROUND_CAP}'`);
    process.exit(1);
  }
  return parseInt(RAW_ROUND_CAP.trim(), 10);
}

/** `json.dumps(obj, ensure_ascii=False)` — python's default `", "` / `": "` separators. */
function pyJson(obj: Record<string, unknown>): string {
  const body = Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ");
  return `{${body}}`;
}

/** `s[:n]` — python slices by CODE POINT, not by UTF-16 unit, so an emoji body truncates alike. */
function head(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/**
 * `" ".join(str(body).split())[:120]`.
 *
 * `.split()` with no argument splits on runs of whitespace and drops the empties,
 * so the collapse happens BEFORE the truncation (contract row 22). See D4 for
 * `str()` on a non-string body.
 */
function excerptOf(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body) ?? String(body);
  return head(s.trim().split(/\s+/).filter(Boolean).join(" "), 120);
}

type Envelope = Record<string, unknown>;

// `re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)`.
const FENCE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
const MD_REQ =
  /^ASK_REQUEST:\s*(\S+)\s*\|\s*from:\s*(\S+)\s*\|\s*thread:\s*(\S+)\s*\|\s*round:\s*(\d+)\s*\|\s*q:\s*(.*)$/;
const MD_REP =
  /^ASK_REPLY:\s*(\S+)\s*\|\s*from:\s*(\S+)\s*\|\s*thread:\s*(\S+)\s*\|\s*round:\s*(\d+)\s*\|\s*a:\s*(.*)$/;

/**
 * `extract_envelope` — a dict envelope from the inject body, or null. Fenced JSON
 * first, then raw JSON, then the markdown ASK_REQUEST/ASK_REPLY fallback (§2).
 */
function extractEnvelope(body: unknown): Envelope | null {
  if (typeof body !== "string") return null;
  const m = FENCE.exec(body);
  const candidate = m ? m[1] : body.trim();
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Envelope;
  } catch {
    /* fall through to the markdown forms */
  }
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    const mr = MD_REQ.exec(line) ?? MD_REP.exec(line);
    if (!mr) continue;
    const kind = line.startsWith("ASK_REQUEST") ? "ask-request" : "ask-reply";
    // `env["question" if … else "answer"] = body` was set here and read by nothing
    // — in_policy and reconcile never look at it — so it is not carried over.
    return { kind, from: mr[2], to: mr[1], thread_id: mr[3], round: parseInt(mr[4], 10) };
  }
  return null;
}

/**
 * §2.3 validity predicate — structural whitelist, not semantic.
 *
 * `isinstance(rnd, int)` was True for a JSON `true` (python bools ARE ints, and
 * `1 <= True <= cap`), so contract row 33 reconciled one; that is reproduced.
 *
 * The `/` refusal is D1's second half: `thread_id` reaches a filesystem path
 * (`<pairkey>__<thread>.json`) straight from an unauthenticated inject body, where
 * it used to crash the whole pass and could name a file outside
 * SESSION_COMMS_DIR. An envelope whose thread id would escape the state dir is
 * exactly the malformed envelope this auditor exists to flag, so it is refused
 * here rather than special-cased later — that routes it to the HOLD path and makes
 * the state path structurally unable to leave the directory.
 */
function inPolicy(env_: Envelope | null, recFrom: string, recTo: string, cap: number): boolean {
  if (!env_) return false;
  if (env_.kind !== "ask-request" && env_.kind !== "ask-reply") return false;
  if (env_.from !== recFrom || env_.to !== recTo) return false;
  const thread = env_.thread_id;
  if (typeof thread !== "string" || thread === "") return false;
  if (thread.includes("/") || thread === "." || thread === "..") return false;
  const rnd = env_.round === true ? 1 : env_.round === false ? 0 : env_.round;
  if (typeof rnd !== "number" || !Number.isInteger(rnd)) return false;
  return rnd >= 1 && rnd <= cap;
}

/** `emit_tele` — one telemetry line appended per classified record. */
function emitTele(
  now: string,
  reason: string,
  recFrom: string,
  recTo: string,
  thread: string,
  pairkey: string,
  excerpt = "",
): void {
  fs.appendFileSync(
    TELE,
    `${pyJson({
      ts: now,
      event: "peer_comms_audit",
      reason,
      from: recFrom,
      to: recTo,
      thread,
      pairkey,
      excerpt: head(excerpt, 120),
    })}\n`,
  );
}

/**
 * Reconcile a raw-inject in-policy envelope into the round counter.
 *
 * `st.setdefault(...)` order is the key order of a file this creates; an existing
 * file keeps its own order and gains only what it is missing — JSON.parse
 * preserves insertion order the same way python's dict does. A file whose bytes do
 * not parse reads as `{}` and is silently replaced with a fresh `rounds: 1` record
 * (contract row 26) — the fail-OPEN that T76 forbids for active.json, reproduced
 * as-is: the same `except` is in bin/ask.sh:200-201, so changing one side alone
 * would only move which process resets the counter. It belongs to D3's ticket.
 * No lock: see D3 in this file's header.
 */
function reconcile(env_: Envelope, pairkey: string, thread: string, now: string, cap: number): void {
  const p = path.join(SESSION_COMMS_DIR, `${pairkey}__${thread}.json`);
  let st: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object") st = parsed as Record<string, unknown>;
  } catch {
    st = {};
  }
  if (!("pairkey" in st)) st.pairkey = pairkey;
  if (!("thread_id" in st)) st.thread_id = thread;
  if (!("rounds" in st)) st.rounds = 0;
  if (!("parties" in st)) st.parties = [String(env_.from), String(env_.to)].sort();
  if (!("status" in st)) st.status = "open";
  if (!("escalated" in st)) st.escalated = false;
  if (env_.kind === "ask-request" && typeof st.rounds === "number" && st.rounds < cap) {
    st.rounds += 1;
  }
  st.last_kind = `${String(env_.kind)}(reconciled)`;
  st.last_round_at = now;
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/**
 * `IFS=$'\t' read -r _tag h_from h_to h_excerpt` over `"\t".join([...])`.
 *
 * D2, reproduced on purpose: tab is IFS *whitespace*, so leading/trailing tabs are
 * stripped and runs collapse into one delimiter. With an empty `from` and `to`,
 * four fields arrive as two and the excerpt lands in `from`. The excerpt itself is
 * always tab-free (`.split()` collapsed it), so no field can absorb a delimiter.
 */
function holdFields(from: string, to: string, excerpt: string): [string, string, string] {
  const f = ["HOLD", from, to, excerpt]
    .join("\t")
    .replace(/^\t+|\t+$/g, "")
    .split(/\t+/);
  return [f[1] ?? "", f[2] ?? "", f[3] ?? ""];
}

function main(): void {
  const cap = roundCap();
  const now = nowIso();
  const orch = new Set(ORCH_SIDS.split(/\s+/).filter(Boolean));
  // `${ORCH_SIDS%% *}` — everything before the first literal SPACE (not any
  // whitespace, unlike the `orch` set's `.split()`). Reproduced as measured.
  const orchSid = ORCH_SIDS.split(" ")[0];

  // Dormant when there is nothing to tail — the always-safe no-op (cf. the
  // reconciler's surface_* consumers). `[ -f ]` is exists-and-regular-file, so a
  // log path that is a directory also exits 0 here, BEFORE the mkdir below: with
  // no peer-inject log this pass creates nothing at all (contract rows 1, 36).
  try {
    if (!fs.statSync(PEER_INJECT_LOG).isFile()) return;
  } catch {
    return;
  }
  try {
    fs.mkdirSync(SESSION_COMMS_DIR, { recursive: true });
  } catch (e) {
    // bash let `mkdir -p` fail and died on `set -e` with mkdir's own message; the
    // code and the fact of a message are the contract, the wording is the
    // implementation's (contract row 27, T116's precedent).
    console.error(`session-comms-auditor: cannot create ${SESSION_COMMS_DIR}: ${(e as Error).message}`);
    process.exit(1);
  }

  // byte-offset cursor (reset if the log shrank/rotated, or if its bytes are junk)
  const size = fs.statSync(PEER_INJECT_LOG).size;
  let start = 0;
  try {
    const n = parseInt(fs.readFileSync(CURSOR, "utf8").trim() || "0", 10);
    start = Number.isNaN(n) ? 0 : n;
  } catch {
    start = 0;
  }
  if (start > size) start = 0;

  const holds: Array<[string, string, string]> = [];
  const chunk = fs.readFileSync(PEER_INJECT_LOG).subarray(start, size).toString("utf8");
  // python's text mode is universal-newlines, so a bare \r terminated a line too.
  for (const line of chunk.split(/\r\n|\r|\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      // A line that is valid JSON but NOT an object fell outside the bash `try`
      // and raised on `.get` one line later — D1's first poison shape. Skipped
      // like any other unparseable line now, which is what that `continue` meant.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const recFrom = typeof rec.from === "string" ? rec.from : "";
    const recTo = typeof rec.to === "string" ? rec.to : "";
    const body = "body" in rec ? rec.body : "";
    // ORCH LANE → out of scope (untouched; never classified/logged).
    if (orch.has(recFrom) || orch.has(recTo)) continue;
    // D1: one record can no longer take the pass — and therefore the cursor — down.
    try {
      const envelope = extractEnvelope(body);
      if (inPolicy(envelope, recFrom, recTo, cap)) {
        const pairkey = [recFrom, recTo].sort().join("__");
        const thread = String((envelope as Envelope).thread_id);
        reconcile(envelope as Envelope, pairkey, thread, now, cap);
        emitTele(now, "peer_ask_reconciled", recFrom, recTo, thread, pairkey);
      } else {
        const pairkey = recFrom && recTo ? [recFrom, recTo].sort().join("__") : "";
        const excerpt = excerptOf(body);
        emitTele(now, "peer_inject_out_of_policy", recFrom, recTo, "", pairkey, excerpt);
        holds.push(holdFields(recFrom, recTo, excerpt));
      }
    } catch (e) {
      // Recorded, not swallowed: the pass keeps its promise that a violation is
      // either escalated or written down. The telemetry write is the one thing
      // that cannot be reported by writing telemetry, so its failure is ignored.
      try {
        emitTele(
          now,
          "peer_audit_record_skipped",
          recFrom,
          recTo,
          "",
          recFrom && recTo ? [recFrom, recTo].sort().join("__") : "",
          `${(e as Error).message}`,
        );
      } catch {
        /* nothing left to report it with */
      }
    }
  }

  fs.writeFileSync(CURSOR, String(size));

  // Route each out-of-policy inject upward: a HOLD into the orchestrator inbox so
  // the orchestrator (HITL) can correct the worker. Phase 1 cannot block in-band;
  // it detects + escalates.
  //
  // #835 — this used to end in `|| true`, and the byte cursor was ALREADY advanced
  // by the pass above. A refused inject therefore lost the escalation permanently:
  // the line is never re-read, so no later tick re-raises it, and the auditor still
  // exited 0. "Telemetry already recorded it" is not a substitute — telemetry is a
  // file nobody is watching; the HOLD is the part that reaches a human. The failure
  // is counted and carried into a non-zero exit, which is the only channel that
  // survives the reconciler's stdio-ignored call (src/reconciler/cli.ts:1293).
  let undelivered = 0;
  for (const [hFrom, hTo, hExcerpt] of holds) {
    const r = spawnSync(
      TELEPTY,
      [
        "inject",
        "--submit",
        orchSid,
        `HOLD: peer-lane out-of-policy inject | from: ${hFrom} | to: ${hTo} | excerpt: ${hExcerpt}`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    if (r.error || (r.status ?? 1) !== 0) {
      undelivered += 1;
      console.error(
        `session-comms-auditor: HOLD UNDELIVERED to '${orchSid}' (from=${hFrom} to=${hTo}) — telepty inject exited non-zero and the audit cursor has already advanced, so this violation will not be re-raised`,
      );
    }
  }

  if (undelivered > 0) {
    console.error(`session-comms-auditor: ${undelivered} escalation(s) undelivered`);
    process.exit(5);
  }
  process.exit(0);
}

main();
