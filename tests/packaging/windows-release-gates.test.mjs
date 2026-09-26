// Local gate-control acceptance only. Runner copies execute test-owned sentinels;
// application Node/npm entrypoints are never executed.
// Node 20; Ruby/Psych, Bash and cat/grep/tail/awk on PATH. No configuration required.
// Optional absolute overrides: WINDOWS_GATE_RUBY, WINDOWS_GATE_BASH,
// WINDOWS_GATE_UTILS (cat/grep/tail/awk directory), WINDOWS_GATE_EVIDENCE.
// See fixtures/windows-gates/README.md for prerequisites, evidence and provenance.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node.split('.')[0], '20', 'acceptance requires Node 20');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function configured(name, env = process.env) {
  const value = env[name];
  if (value === undefined) return undefined;
  assert.ok(value && isAbsolute(value) && !/[\r\n]/.test(value), `${name}: absolute path required when set`);
  return value;
}
function resolveTool(name, override, env = process.env) {
  const explicit = configured(override, env);
  const candidates = explicit ? [override === 'WINDOWS_GATE_UTILS' ? join(explicit, name) : explicit]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Try the next PATH entry; explicit overrides never fall back. */ }
  }
  throw new Error(`Missing prerequisite ${name}: install it on PATH or set ${override} to an executable absolute ${override === 'WINDOWS_GATE_UTILS' ? 'directory' : 'path'}${explicit ? ` (unusable override: ${explicit})` : ''}`);
}
const ruby = resolveTool('ruby', 'WINDOWS_GATE_RUBY');
const bash = resolveTool('bash', 'WINDOWS_GATE_BASH');
const utilityNames = ['cat', 'grep', 'tail', 'awk'];
const utilities = Object.fromEntries(utilityNames.map(name => [name, resolveTool(name, 'WINDOWS_GATE_UTILS')]));
const admin = mkdtempSync(join(tmpdir(), 'windows-release-gates-'));
chmodSync(admin, 0o700);
const evidence = configured('WINDOWS_GATE_EVIDENCE') ?? join(admin, 'evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
console.log(`Windows gate evidence: ${evidence}`);
const timeout = 5000;
const manifest = [];
const invocations = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureRoot = 'tests/packaging/fixtures/windows-gates';
const frozen = {
  [`${fixtureRoot}/ci.before-parity.yml`]: '10849b92e1421996998aedabacc84c191449deaa8baa632fb0da8a4b85ecddd1',
  [`${fixtureRoot}/release.before.yml`]: 'da142d4151f621b6b497c1a7d1814bb77e9eba2e6991f5f71df6b69405fa3011',
  [`${fixtureRoot}/rejected-release.yml`]: '8b4ad689397f4d0e2776794ed49f401e1f95216ddcea8bf9fd54bc9f6ff04933',
};
function snapshot() {
  const result = {};
  function visit(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result[child] = sha(readFileSync(join(root, child)));
    }
  }
  for (const path of ['src', 'bin', 'scripts', '.github', 'tests/session/persistence']) visit(path);
  for (const path of ['package.json', 'package-lock.json', 'tests/packaging/windows-release-gates.test.mjs', ...Object.keys(frozen)]) {
    result[path] = sha(readFileSync(join(root, path)));
  }
  return result;
}
const before = snapshot();
writeFileSync(join(evidence, 'source-before.json'), JSON.stringify(before, null, 2));
for (const [path, hash] of Object.entries(frozen)) assert.equal(before[path], hash, `frozen source: ${path}`);

// Psych safe_load provides structured parsing; YAML 1.1 turns the key "on"
// into boolean true, which JSON encodes as "true". Normalize that key only.
const parser = 'require "yaml"; require "json"; d = YAML.safe_load(ARGV.fetch(0) == "-" ? STDIN.read : File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false); d["on"] = d.delete(true) if d.key?(true); puts JSON.generate(d)';
function parse(path, source) {
  // Use standard-library Psych without RubyGems startup hooks or PATH helpers.
  const argv = ['--disable-gems', '-e', parser, source === undefined ? join(root, path) : '-'];
  const result = spawnSync(ruby, argv, { input: source, encoding: 'utf8', timeout, env: { PATH: '' } });
  invocations.push({ kind: 'yaml-parser', executable: ruby, argv, timeout, exit: result.status, stderr: result.stderr });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Ruby/Psych prerequisite or YAML parsing failure: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const original = parse(`${fixtureRoot}/release.before.yml`);
const final = parse('.github/workflows/release.yml');
const ci = parse('.github/workflows/ci.yml');
const ciBefore = parse(`${fixtureRoot}/ci.before-parity.yml`);
const rejected = parse(`${fixtureRoot}/rejected-release.yml`);
const ids = ['windows-persistence', 'windows-refuses'];
const lf = source => source.replace(/\r\n/g, '\n');
// Independent approved contract, never derived from either workflow under test.
// Keep the exact block too: CI's historical byte comparison may remove only this.
const browserAddition = `  browser-tls:
    name: Browser and TLS acceptance
    runs-on: ubuntu-22.04
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '20.20.0'
      - name: Require disposable non-root Linux runner and TLS tools
        run: |
          set -euo pipefail
          test "$(id -u)" -ne 0
          test "$RUNNER_ENVIRONMENT" = github-hosted
          sudo apt-get update
          sudo apt-get install -y openssl libnss3-tools
      - name: Fresh locked install and build
        run: |
          set -euo pipefail
          npm ci
          npm run build
      - name: Install pinned Chromium with sandbox dependencies
        run: |
          set -euo pipefail
          node -e "const p=require('playwright/package.json');const b=JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:path').dirname(require.resolve('playwright-core/package.json')),'browsers.json'))).browsers.find(x=>x.name==='chromium');if(p.version!=='1.58.2'||b.revision!=='1208'||b.browserVersion!=='145.0.7632.6')process.exit(1)"
          npx --no-install playwright install --with-deps chromium
      # No new dependency: the step above already pulled Xvfb and xauth in as Chromium's
      # documented headed prerequisites. This only proves they are present before the
      # acceptance run, so a missing tool fails as a named preflight rather than as a
      # ten-minute browser timeout. Nothing is installed, downloaded or version-pinned here.
      - name: Preflight virtual display tools for headed Chromium
        run: |
          set -euo pipefail
          command -v Xvfb
          command -v xvfb-run
          command -v xauth
      - name: Actual browser, WebAuthn and TLS controls
        env:
          BROWSER_TLS_RECEIPT: \${{ runner.temp }}/browser-tls-receipt.json
          CONSOLE_UI_ARTIFACTS: \${{ runner.temp }}/console-ui-artifacts
        # Headed Chromium on a private virtual display owned by this non-root ephemeral
        # runner. \`-a\` picks a free server number; \`-nolisten tcp\` keeps the display off the
        # network entirely; \`xvfb-run\` creates the X authority cookie under the runner's own
        # uid and exports only DISPLAY and XAUTHORITY, which is all the acceptance forwards
        # to the browser. X authentication stays on and no sandbox or TLS flag changes.
        # \`umask 077\` first so the authority cookie the wrapper creates is owner-only by
        # construction rather than by whatever default the image happens to carry.
        run: |
          set -euo pipefail
          umask 077
          xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" npm run test:browser-tls
        timeout-minutes: 10
      - name: Validate complete receipt against this checkout
        env:
          BROWSER_TLS_RECEIPT: \${{ runner.temp }}/browser-tls-receipt.json
          CONSOLE_UI_ARTIFACTS: \${{ runner.temp }}/console-ui-artifacts
        run: npm run test:browser-tls -- --validate-receipt
      - name: Upload sanitized receipt only
        uses: actions/upload-artifact@v4
        with:
          name: browser-tls-receipt
          path: \${{ runner.temp }}/browser-tls-receipt.json
          if-no-files-found: error
          retention-days: 7
      # The six files are enumerated one per line rather than globbed. The run asserts that
      # this directory holds exactly this set, so a wildcard would upload whatever a later
      # step happened to leave behind instead of failing on it. Only these six are written
      # there — no invitation, QR, passkey, cookie, session token, auth directory or private
      # log — and TEMP at large is never uploaded. Success-only by default, so a failed run
      # cannot publish a partial or unvalidated evidence set; it runs after the complete
      # receipt validation above for the same reason.
      - name: Upload Console UI evidence
        uses: actions/upload-artifact@v4
        with:
          name: console-ui-evidence
          path: |
            \${{ runner.temp }}/console-ui-artifacts/console-320.png
            \${{ runner.temp }}/console-ui-artifacts/console-390.png
            \${{ runner.temp }}/console-ui-artifacts/console-768.png
            \${{ runner.temp }}/console-ui-artifacts/console-1440.png
            \${{ runner.temp }}/console-ui-artifacts/console-zoom.png
            \${{ runner.temp }}/console-ui-artifacts/console-ui-receipt.json
          if-no-files-found: error
          retention-days: 7

`;
// The approved headed caller as it stands in release.yml: wrapper, owner-only authority
// cookie, a display that never listens on TCP, and nothing else.
const approvedHeadedCaller = `        run: |
          set -euo pipefail
          umask 077
          xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" npm run test:browser-tls
`;
// CI — and only CI — additionally carries the approved wm-shape observation and, since #1177,
// the ONE owned-window-manager experiment that observation exists to have motivated. Each is
// restated here as an independent literal and held to the bounds it was approved under, never
// accepted merely because the workflow currently contains it:
//   * Two read-only observations, taken BEFORE anything starts. `installed` is a PATH lookup
//     over a fixed list and nothing more; `ewmh-property` is one EWMH root-window property. An
//     observation that could not be made is `unknown`, never `absent`; only a zero xprop exit
//     is parsed; the property VALUE is never printed; and no check reads either one — the
//     supervisor takes its OWN baseline rather than reading `$ewmh`.
//   * Exactly one window manager is started, on the display this caller created, by ONE
//     synchronous supervisor holding one `Popen` handle per owned child. No concurrent reaper,
//     no background watchdog, no second waiter, no `pkill`, no name match, no process scan and
//     no process group: only what the supervisor started is ever signalled, and every signal
//     goes through the handle, which will not signal a child it has already reaped.
//   * Stopping is bounded and escalates only while the child is still owned and unreaped: TERM,
//     bounded join, KILL, bounded final join. SIGKILL is NOT assumed to be instant — a final
//     join that still expires is a named cleanup failure.
//   * ONE cleanup path, reached from a refusal, a red suite, a green suite and a cancellation
//     alike. INT and TERM are RECORDED ONLY — the handler never raises, so no signal unwinds
//     any path at any interpreter point and cleanup can never be abandoned part-way. A
//     recorded cancellation is acted on synchronously by bounded polls at the readiness and
//     suite waits, and the FIRST signal recorded fixes the exit status, so a repeat storm
//     can neither re-enter the handler nor move the status.
//   * Suite status and cleanup errors are captured separately: the acceptance status is
//     re-raised verbatim and cleanup never masks it, and a green suite whose cleanup failed is
//     turned red rather than reported as a pass.
//   * Readiness is PROVEN, not inferred from a property being present. Root -> W -> itself, the
//     name, a live owned child, and a `_NET_WM_PID` that is exactly the owned child are ALL
//     required; a missing, malformed, unreadable or foreign `_NET_WM_PID` refuses, and neither
//     the private display nor the absent-to-present transition nor the name is accepted in its
//     place. Every xprop call is bounded and clamped to the one readiness deadline.
//   * The 10-minute caller budget is untouched, and the install is a separate step so its cost
//     is not charged to it.
// release.yml keeps the plain caller and starts no window manager and no supervisor, so the two
// contracts are stated separately here rather than either one being inferred from the other.
const ciCallerRationale = `        # Two independent, read-only observations, made INSIDE this same \`xvfb-run\` because \`-a\`
        # picks a fresh server number per invocation, so a separate step would observe a different
        # display. Neither is a window-manager verdict, and neither is read by any check:
        #   \`installed\` - whether a binary from a fixed list exists on PATH. Nothing more: not
        #   whether it runs, and not whether it touches this display.
        #   \`ewmh-property\` - whether the EWMH \`_NET_SUPPORTING_WM_CHECK\` property is set on this
        #   display's root window. \`present\` is EWMH registration, which can be stale; \`absent\` is
        #   the absence of that registration ONLY, and is NOT proof that no window manager
        #   controls the display; \`unknown\` is an observation that did not happen or did not come
        #   back in the expected shape, which is never reported as absence.
        # Those two observations still install, download and configure nothing, take no root or
        # sudo, scan no process list and never print the property VALUE - the exit status and the
        # expected output shape are matched there and discarded there. Non-fatal by construction,
        # to stderr, which survives the exit 1 the success-only uploads below do not. They are
        # taken BEFORE the experiment so the display's prior shape is on the record either way,
        # and they authorize nothing: no check reads either one, and the supervisor below does not
        # read \`$ewmh\` - it takes its own baseline, so the observation can never gate, shorten or
        # substitute for the ownership proof.
        # #1177 THE EXPERIMENT, and the only thing in this file that starts a process on this
        # display: one Openbox, started by one supervisor, owned by it, stopped by it.
        #   * Started on THIS display - inside this same \`xvfb-run\`, so it is the server number
        #     the acceptance run is about to use rather than a different one a separate step
        #     would have got from \`-a\`.
        #   * ONE synchronous owner. The supervisor is a standard-library \`Popen\` handle per
        #     owned child and nothing else: no concurrent reaper, no background watchdog, no
        #     second waiter. Every signal goes through the handle, which will not signal a child
        #     it has already reaped, so no numeric pid is ever signalled after the join and a
        #     recycled pid cannot be hit. No \`pkill\`, no name match, no process scan, no process
        #     group: the only processes signalled are the ones this supervisor started.
        #   * Stopping is BOUNDED and escalates only while the child is still owned and unreaped:
        #     TERM, bounded join, then KILL, then a bounded final join. SIGKILL is not claimed to
        #     be instant - a join that still expires is reported as a named cleanup failure.
        #   * ONE cleanup path, reached from a refusal, a red suite, a green suite and a
        #     cancellation alike. INT and TERM are RECORDED ONLY: the handler never raises, so
        #     no signal unwinds any path at any interpreter point and this cleanup can never be
        #     abandoned part-way. A recorded cancellation is acted on synchronously by bounded
        #     polls at the readiness and suite waits, both signals are ignored after the first,
        #     and the FIRST signal recorded fixes the exit status, so repeats cannot move it.
        #   * Suite status and cleanup errors are captured separately. The acceptance status is
        #     re-raised verbatim, so a red suite stays red and reports its own status and cleanup
        #     never masks it; a GREEN suite whose cleanup failed is turned red, not called a pass.
        #   * Ownership is PROVEN, not inferred from a property being present, and the exact
        #     \`_NET_WM_PID\` binding is required: see the supervisor's own readiness comment.
        #   * The suite is byte-unchanged: the same \`npm run test:browser-tls\`, no fixture,
        #     product, Playwright or sandbox change, no forced or synthesized visibility. It runs
        #     as an owned child so a cancellation stops what this caller started; its own
        #     descendants are NOT signalled, because reaching them would mean assuming a process
        #     group, which is outside what this was authorized to do.
        # This may well stay red, and a verified-ownership run that is still red would be a REAL
        # result. It resolves exactly ONE environmental hypothesis - whether a real EWMH window
        # manager on this display changes what the lifecycle stage observes. It is NOT a claim
        # that an absent WM caused the failure, it closes no task-table gate, and it does not
        # touch the live competing explanation: the harness restores the window BEFORE
        # \`lw-hidden-wait\` runs, so that wait still polls a window in state \`normal\` whether or
        # not a window manager is present.
`;
const ciDiagnosticRun = `          # The supervisor is written out here, under that same \`umask 077\`, so the file is
          # owner-only by construction. It is a CI-only file in RUNNER_TEMP, run by the runner
          # image's own \`python3\`: nothing is installed to produce it, it never enters the
          # package, and release.yml has no equivalent.
          export WM_SUPERVISOR="$RUNNER_TEMP/wm-owned-supervisor.py"
          cat >"$WM_SUPERVISOR" <<"PY"
          # #1177 owned-process supervisor, CI only and deliberately not a product module: it
          # starts ONE window manager on the display this xvfb-run already owns, proves that
          # exact process owns it, runs the unchanged acceptance suite, and stops only what it
          # started. Standard library only, and one synchronous owner from start to finish.
          import re
          import signal
          import subprocess
          import sys
          import time

          READY_SECONDS = 30.0   # whole readiness phase, the baseline read included
          PROBE_SECONDS = 5.0    # per-xprop bound, clamped to what is left of READY_SECONDS
          TERM_SECONDS = 10.0    # bounded join after SIGTERM
          KILL_SECONDS = 5.0     # bounded join after SIGKILL
          POLL_SECONDS = 0.5     # cancellation poll at each wait taken before cleanup
          EVIDENCE_BYTES = 200   # per-stream cap on what one probe record may carry
          SUPPORTING = "_NET_SUPPORTING_WM_CHECK"
          YESNO = {True: "yes", False: "no"}
          # Path-shaped tokens are redacted out of DIAGNOSTIC streams only. This is a BOUND on
          # what a record may carry and not a parser: it matches the RAW capped bytes, before
          # the printable rendering below, and redacting more than a path is always safe here
          # while redacting less is not, so it deliberately runs to the next space rather than
          # trying to be exact. It is a BYTES pattern because nothing here ever decodes.
          PATHLIKE = re.compile(b"/[^ ]*")
          # The specific gap each refusal reports, so a failure names what was missing rather
          # than only that something was.
          GAP = {
              "exited": "the owned Openbox exited before any ownership evidence appeared",
              "timeout": "no ownership evidence appeared inside the readiness deadline",
              "cancelled": "the run was cancelled before ownership could be proved",
              "not-self-consistent": "the supporting window did not point back at itself, so"
                                     " that registration is stale",
              "unnamed": "the supporting window published no readable _NET_WM_NAME",
              "foreign-wm": "the supporting window belongs to a different window manager",
              "pid-missing": "Openbox published no _NET_WM_PID on its supporting window",
              "pid-malformed": "the _NET_WM_PID on the supporting window was not a plain number",
              "pid-unreadable": "the _NET_WM_PID on the supporting window could not be read",
              "pid-foreign": "the _NET_WM_PID on the supporting window is another process",
          }
          BINDING = {"owned": "owned", "pid-missing": "missing", "pid-foreign": "foreign",
                     "pid-malformed": "malformed", "pid-unreadable": "unreadable"}
          CANCELLED = []   # every INT/TERM the handler recorded, first signal first
          CLEANING = []    # set when the one cleanup path begins: a record, not a guard


          def cancel(number, frame):
              # RECORD ONLY. This handler never raises, at any interpreter point, and that is
              # what closes the cancellation race: the raise this used to do when cleanup had
              # not yet been marked could be delivered between entering the \`finally\` below and
              # setting that marker, and then unwound straight OUT of cleanup - leaving the
              # owned window manager running and producing no named status at all. Nothing
              # here depends on winning that window any more. Both signals are ignored from
              # here on, so the repeats a cancelled job sends cannot re-enter this handler,
              # and the FIRST number recorded is the one the exit status is built from. A
              # recorded cancellation is ACTED on synchronously, by the bounded polls at the
              # readiness and suite waits below, and never from inside this handler.
              signal.signal(signal.SIGINT, signal.SIG_IGN)
              signal.signal(signal.SIGTERM, signal.SIG_IGN)
              CANCELLED.append(number)


          def note(text):
              sys.stderr.write("browser-tls ci: %s\\n" % text)
              sys.stderr.flush()


          def problem(text):
              sys.stderr.write("::error::%s\\n" % text)
              sys.stderr.flush()


          def sanitize(raw, redact):
              """One captured stream, rendered bounded, single-line and printable. The cap is
              applied to the RAW bytes first, so what is recorded can never grow with what the
              tool printed, and truncation is returned on its own rather than being hidden
              inside the text. Rendering is per RAW BYTE and NEVER decodes: a byte stands for
              itself only when it is printable ASCII and is not one of the two delimiters this
              renders with, and every other byte becomes its own exact <hh>. So a newline or a
              control byte can neither forge a second log line nor be mistaken for content,
              and two bytes that differ on the wire can never render alike - an undecodable
              byte, a non-ASCII byte and a multibyte sequence the cap split each keep their
              own identity instead of collapsing into one replacement character. What is
              rendered is therefore what was captured, byte for byte, within the cap: for a
              stream recorded WITHOUT redaction the original bytes are recoverable from the
              rendering, while a DIAGNOSTIC stream has path-shaped tokens replaced before that
              rendering and so is bounded and redacted rather than exact."""
              data = raw or b""
              kept = data[:EVIDENCE_BYTES]
              if redact:
                  kept = PATHLIKE.sub(b"(path)", kept)
              shown = "".join(chr(b) if 32 <= b < 127 and chr(b) not in '<"' else "<%02x>" % b
                              for b in kept)
              return (shown, len(data), len(data) > EVIDENCE_BYTES)


          def record(evidence, name, status, out, err, timed_out):
              """Append exactly one bounded probe record, or nothing at all when the caller did
              not ask for one. The classified status, the truncation of each stream and the
              timeout are each their OWN field: none of them can be lost inside another, and
              none of them is ever folded into an absence. Nothing else about the run is
              recorded - no environment, no argument vector, no process listing."""
              if evidence is None:
                  return
              shown_out, out_bytes, out_cut = sanitize(out, False)
              shown_err, err_bytes, err_cut = sanitize(err, True)
              evidence.append('property=%s status=%s timed-out=%s stdout-bytes=%d'
                              ' stdout-truncated=%s stdout="%s" stderr-bytes=%d'
                              ' stderr-truncated=%s stderr="%s"'
                              % (name, status, YESNO[timed_out], out_bytes, YESNO[out_cut],
                                 shown_out, err_bytes, YESNO[err_cut], shown_err))


          def read(target, name, deadline, evidence=None):
              """One bounded xprop read. Returns (state, text) with state ok, absent or
              unknown. Unknown is anything that did not come back in a recognised shape - a
              missing tool, a non-zero exit, a timeout, output this does not parse - and is
              never reported as absence. The per-call bound is clamped to what is left of the
              shared readiness deadline, so no sequence of probes can outlive it.
              When \`evidence\` is supplied it receives exactly one bounded, sanitized record of
              what this invocation actually did: the classified status, the property response
              it printed rendered byte for byte, and its path-redacted diagnostic stderr, with
              truncation and the timeout as their own fields. That record is DIAGNOSTIC
              ONLY. \`text\` below is still the one thing any caller classifies, it is still
              produced from stdout exactly as before, and no state returned here reads, or
              is weakened by, what was recorded."""
              left = deadline - time.monotonic()
              if left <= 0:
                  record(evidence, name, "not-invoked-deadline-passed", b"", b"", False)
                  return ("unknown", "")
              try:
                  done = subprocess.run(["xprop"] + target + ["-notype", name],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE,
                                        timeout=min(PROBE_SECONDS, left))
              except subprocess.TimeoutExpired as expired:
                  # The bound expired. Whatever the tool had already printed is kept, and the
                  # timeout is its own recorded field rather than an empty reading that would
                  # look the same as a tool which printed nothing.
                  record(evidence, name, "timed-out", expired.stdout, expired.stderr, True)
                  return ("unknown", "")
              except OSError as failure:
                  # The tool could not be run at all. Only the numeric errno is recorded: the
                  # message can carry a path and nothing here needs one.
                  record(evidence, name, "not-invoked-errno-%s" % failure.errno,
                         b"", b"", False)
                  return ("unknown", "")
              # Recorded BEFORE the classification below, so a non-zero exit and an output
              # shape this does not parse are each distinguishable afterwards instead of
              # collapsing into the same bare "unknown".
              record(evidence, name, "exit-%d" % done.returncode, done.stdout, done.stderr,
                     False)
              if done.returncode != 0:
                  return ("unknown", "")
              text = done.stdout.decode("utf-8", "replace").strip()
              # #1177 xprop prints TWO exit-zero absence forms, both from Show_Prop and both
              # about the ONE property it was asked for, so both are read as absence of that
              # property and nothing wider. Corroborated against the official X.Org source
              # (xprop.c, Show_Prop): \`Parse_Atom(prop, True)\` is
              # \`XInternAtom(dpy, name, only_if_exists=True)\`, which returns None when the
              # name is not interned on this server at all - so it cannot be set on ANY
              # window - and that path prints ":  no such atom on any window."; otherwise a
              # property the window does not carry prints ":  not found.". Recognising only
              # the second is the measured defect: a display whose server had never interned
              # _NET_SUPPORTING_WM_CHECK answered with the first, and an observed absence was
              # rejected as unknown, so nothing was started. Each form is matched ANCHORED and
              # against THIS property name, so a response about a different property, a
              # truncated or extended one, and any other shape all stay unknown; the non-zero
              # exit, the timeout and the missing tool above stay unknown as well.
              if re.match("^" + name + r":\\s+not found\\.$", text):
                  return ("absent", "")
              if re.match("^" + name + r":\\s+no such atom on any window\\.$", text):
                  return ("absent", "")
              return ("ok", text)


          def supporting(target, deadline, evidence=None):
              """The EWMH supporting window that \`target\` points at, as an int."""
              state, text = read(target, SUPPORTING, deadline, evidence)
              if state != "ok":
                  return (state, None)
              found = re.match("^" + SUPPORTING + r": window id # (0x[0-9a-fA-F]+)$", text)
              if not found:
                  return ("unknown", None)
              return ("value", int(found.group(1), 16))


          def wm_name(window, deadline):
              state, text = read(["-id", hex(window)], "_NET_WM_NAME", deadline)
              if state != "ok":
                  return (state, None)
              found = re.match('^_NET_WM_NAME = "(.*)"$', text)
              if not found:
                  return ("unknown", None)
              return ("value", found.group(1))


          def wm_pid(window, deadline):
              """The pid the supporting window claims for itself. A shape this cannot parse is
              malformed, which refuses; it is never rounded down to absence."""
              state, text = read(["-id", hex(window)], "_NET_WM_PID", deadline)
              if state != "ok":
                  return (state, None)
              found = re.match("^_NET_WM_PID = ([0-9]+)$", text)
              if not found:
                  return ("malformed", None)
              return ("value", int(found.group(1)))


          def readiness(wm, deadline):
              """Bounded proof that THIS child owns THIS display, or a named refusal. All of
              these are required, in order: the root points at a supporting window W; W points
              back at itself, which is the EWMH staleness test; W is named Openbox; W carries a
              _NET_WM_PID that is exactly this child pid; and the child is still alive at the
              end. A missing, malformed, unreadable or foreign _NET_WM_PID REFUSES - the
              private display, the observed absent-to-present transition and the window name
              are each necessary and not one of them is accepted in its place."""
              while True:
                  if CANCELLED:
                      return "cancelled"
                  if wm.poll() is not None:
                      return "exited"
                  if deadline - time.monotonic() <= 0:
                      return "timeout"
                  state, window = supporting(["-root"], deadline)
                  if state != "value":
                      pause(1)   # not registered yet; the deadline above ends this wait
                      continue
                  state, back = supporting(["-id", hex(window)], deadline)
                  if state != "value" or back != window:
                      return "not-self-consistent"
                  state, name = wm_name(window, deadline)
                  if state != "value":
                      return "unnamed"
                  if "Openbox" not in name:
                      return "foreign-wm"
                  state, claimed = wm_pid(window, deadline)
                  if state == "absent":
                      return "pid-missing"
                  if state == "malformed":
                      return "pid-malformed"
                  if state != "value":
                      return "pid-unreadable"
                  if claimed != wm.pid:
                      return "pid-foreign"
                  if wm.poll() is not None:
                      return "exited"
                  return "owned"


          def join(child, seconds):
              """Bounded join: True when the child is reaped, False when the bound expired."""
              try:
                  child.wait(timeout=seconds)
                  return True
              except subprocess.TimeoutExpired:
                  return False


          def pause(seconds):
              """A bounded sleep that also ends on a recorded cancellation, so no wait taken
              before cleanup begins outlives the first INT/TERM by more than one poll. It is
              a shorter sleep, never a longer one: the caller's own deadline still ends the
              wait it is inside."""
              end = time.monotonic() + seconds
              while not CANCELLED:
                  left = end - time.monotonic()
                  if left <= 0:
                      return
                  time.sleep(min(POLL_SECONDS, left))


          def await_owned(child):
              """Wait for this owned child by BOUNDED POLL, so a cancellation the handler
              recorded is acted on here, synchronously, instead of unwinding this wait from a
              signal handler. Returns the child status, or None when a cancellation ended the
              wait before the child finished. Nothing is signalled here and nothing is
              reaped early: stopping and joining every owned child stays the one cleanup
              path's job, which this returns into either way."""
              while not CANCELLED:
                  try:
                      return child.wait(timeout=POLL_SECONDS)
                  except subprocess.TimeoutExpired:
                      continue
              return None


          def stop(child, what):
              """Stop and join exactly this owned child, synchronously. TERM, bounded join;
              KILL only while this child is still owned and unreaped; bounded final join. Both
              signals go through this handle, which will not signal a child it has already
              reaped, so no numeric pid is signalled after the join and a recycled pid cannot
              be hit. Nothing else is signalled: no scan, no name match, no process group.
              SIGKILL is not claimed to be instant - a final join that still expires is
              reported. Returns None, or the cleanup failure to report."""
              if child.poll() is not None:
                  return None
              child.terminate()
              if join(child, TERM_SECONDS):
                  return None
              child.kill()
              if join(child, KILL_SECONDS):
                  return None
              return ("the owned %s (pid %d) was still unreaped %gs after SIGKILL, so this step"
                      " cannot claim it released the display" % (what, child.pid, KILL_SECONDS))


          def main():
              started = time.monotonic()
              deadline = started + READY_SECONDS
              # A supporting window that is ALREADY here belongs to something this caller did
              # not start, and an initial state that could not be READ is not an absent one:
              # the absent-to-present transition is only evidence if the absence was observed.
              # Both refuse, and nothing is started.
              # The INITIAL read carries its own evidence, because a bare "unknown" cannot be
              # told apart from a missing tool, an X server that refused the connection, a
              # probe that hit its bound and a response this does not parse - and the refusal
              # below turns exactly that distinction into a red job with nothing to act on.
              # The record is emitted on EVERY outcome and before any verdict, so the display's
              # initial reading is on the record whether this refuses or goes on; it goes to
              # stderr, which survives the exit 1 below where the success-only uploads do not;
              # and it is read by NOTHING. No branch below consults it, so it can neither
              # relax the refusal, nor shorten the readiness proof, nor stand in for an
              # observation that was not made. An unknown stays unknown - this reports WHY it
              # was unknown, and changes nothing about it being fail-closed.
              probe = []
              state, existing = supporting(["-root"], deadline, probe)
              for seen in probe:
                  note("wm-baseline-probe (%s)" % seen)
              if state == "value":
                  problem("a supporting window (0x%x) already owned this display before the"
                          " experiment started, so that registration is foreign or stale."
                          " Nothing was started and the acceptance suite was NOT run."
                          % existing)
                  return 1
              if state != "absent":
                  problem("the initial %s state of this display came back %s, and an unreadable"
                          " initial state is not an absent one. Nothing was started and the"
                          " acceptance suite was NOT run." % (SUPPORTING, state))
                  return 1
              # Armed BEFORE anything is owned, so a cancellation can never land in the window
              # between starting the child and being able to stop it. Nothing above this line
              # owns a process, so up to here the default disposition is the right one.
              signal.signal(signal.SIGINT, cancel)
              signal.signal(signal.SIGTERM, cancel)
              # Openbox stdout goes to stderr so nothing it prints can be read as test output.
              # This handle is the one owned window manager and the only thing ever signalled.
              wm = subprocess.Popen(["openbox", "--sm-disable"], stdin=subprocess.DEVNULL,
                                    stdout=sys.stderr, stderr=sys.stderr)
              suite = None
              suite_rc = None
              ready = "not-reached"
              cleanup_rc = 0
              try:
                  ready = readiness(wm, deadline)
                  note("wm-owned (started=openbox readiness=%s pid-binding=%s waited=%.1fs)"
                       % (ready, BINDING.get(ready, "unread"), time.monotonic() - started))
                  if ready == "owned":
                      suite = subprocess.Popen(["npm", "run", "test:browser-tls"])
                      suite_rc = await_owned(suite)
              finally:
                  # THE cleanup path, and now the ONLY way out of the block above. No
                  # cancellation can unwind out of it because the handler never raises - NOT
                  # because this marker and these two SIG_IGNs win a race against one. CLEANING
                  # records that cleanup has begun, and the SIG_IGNs drop the repeats a
                  # cancelled job sends; neither has to be reached before a signal arrives for
                  # this block to run to the end. Then each owned child is stopped and joined
                  # exactly once, newest first, and a cancellation recorded while that is in
                  # progress is recorded only and does not shorten it.
                  CLEANING.append(True)
                  signal.signal(signal.SIGINT, signal.SIG_IGN)
                  signal.signal(signal.SIGTERM, signal.SIG_IGN)
                  owned = 0
                  for child, what in ((suite, "acceptance suite"), (wm, "Openbox")):
                      if child is None:
                          continue
                      owned += 1
                      trouble = stop(child, what)
                      if trouble is not None:
                          problem(trouble)
                          cleanup_rc = 1
                  # Descendants of the suite are deliberately NOT signalled: only what this
                  # supervisor started is owned, and reaching the rest would mean assuming a
                  # process group. Whether any survive is not measured here.
                  note("wm-cleanup (owned-processes=%d cleanup-errors=%d"
                       " unowned-descendants=not-signalled)" % (owned, cleanup_rc))
              if CANCELLED:
                  note("wm-cancelled (signal=%d)" % CANCELLED[0])
                  return 128 + CANCELLED[0]
              if ready != "owned":
                  problem("the owned Openbox never proved it owns this display (readiness=%s):"
                          " %s. The exact _NET_WM_PID binding is REQUIRED and is not downgraded"
                          " - the private display, the absent-to-present transition and the"
                          " window name do not replace it - and no other window manager is"
                          " selected instead. The acceptance suite was NOT run and nothing was"
                          " measured." % (ready, GAP.get(ready, "no ownership evidence")))
                  return 1
              if suite_rc is None:
                  problem("the acceptance suite reported no status, which cannot be read as a"
                          " pass.")
                  return 1
              if suite_rc != 0:
                  # The acceptance failure is this step status, verbatim. Cleanup trouble is
                  # reported on its own above and never overwrites or masks it.
                  return suite_rc if suite_rc > 0 else 128 - suite_rc
              if cleanup_rc:
                  problem("the acceptance suite passed but an owned process could not be"
                          " stopped and joined, so this run is reported as a failure rather"
                          " than as a pass.")
                  return 1
              return 0


          if __name__ == "__main__":
              sys.exit(main())
          PY
          xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" bash -c '
            set -u
            installed=none
            for wm in mutter metacity marco xfwm4 openbox fluxbox i3 kwin_x11; do
              if command -v "$wm" >/dev/null 2>&1; then installed="$wm"; break; fi
            done
            # An observation that could not be made is unknown, never absence: a missing tool, a
            # nonzero or timed-out xprop and an unrecognized output shape all stay unknown. The
            # exit status is captured on its own line rather than discarded by ||true, and the
            # read is substituted rather than piped so no readers SIGPIPE can become the verdict.
            ewmh=unknown
            if command -v xprop >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
              root=$(timeout 5 xprop -root -notype _NET_SUPPORTING_WM_CHECK 2>/dev/null)
              status=$?
              if [ "$status" -eq 0 ]; then
                case "$root" in
                  "_NET_SUPPORTING_WM_CHECK: window id # 0x"*) ewmh=present ;;
                  "_NET_SUPPORTING_WM_CHECK:"*"not found.") ewmh=absent ;;
                  # #1177 the other exit-zero absence form xprop prints for this same one
                  # property, aligned with the supervisor parser above and no wider. Written
                  # as the WHOLE exact response with no wildcard, so no arbitrary text may
                  # precede the phrase: Show_Prop prints ":  no such atom on any window."
                  # directly after the property name with those exact two spaces, and the
                  # command substitution has already dropped the one trailing newline. Still
                  # classified only on a zero exit. This stays DIAGNOSTIC: no check reads
                  # ewmh, the supervisor takes its own baseline, and what is captured here is
                  # unchanged. NOTE no apostrophe may appear in this block, which is one
                  # single-quoted bash -c argument.
                  "_NET_SUPPORTING_WM_CHECK:  no such atom on any window.") ewmh=absent ;;
                  *) ewmh=unknown ;;
                esac
              fi
            fi
            printf "browser-tls ci: wm-shape (display=owned installed=%s ewmh-property=%s)\\n" "$installed" "$ewmh" >&2
            exec python3 "$WM_SUPERVISOR"
          '
`;
const ciHeadedCaller = `${ciCallerRationale}        run: |
          set -euo pipefail
          umask 077
${ciDiagnosticRun}`;
// The acceptance step's own `- name:` line. Needed twice — as the end boundary of the
// approved-contract slices below, and as the anchor the CI-only install step is inserted
// before — so it is named once here and both uses point at it rather than restating bytes.
const browserCallerStep = '      - name: Actual browser, WebAuthn and TLS controls\n';
// The CI-only window-manager install, restated independently for the same reason as the
// caller: it is held to what it was approved as, not to what the workflow happens to carry.
const ciOpenboxInstall = `      # #1177 — the ONE bounded window-manager experiment, CI only and only here. The display
      # the acceptance run owns has never had a window manager on it: \`Browser.setWindowBounds
      # {windowState:'minimized'}\` reads back \`normal\`, and both owned tabs stay \`visible\` while
      # focus moves. That is evidence, NOT proof that an absent WM is the cause, so this installs
      # a real EWMH window manager and measures the SAME suite against it rather than asserting
      # anything. Openbox is the smallest EWMH-compliant choice in the image's archive; x11-utils
      # supplies the \`xprop\` the ownership check below reads, which the observation-only probe
      # treats as optional and this experiment requires. Both are installed in this separate step
      # so the install cost lands outside the acceptance step's unchanged 10-minute budget and
      # outside the real browser user process entirely, and \`apt-get update\` already ran in the
      # runner preflight above. \`python3\` is NOT installed: the supervisor below is one file of
      # its standard library, so the interpreter the runner image already ships is proved present
      # here instead of anything being added to get it. Nothing is installed on a host, nothing
      # enters package.json or package-lock.json, no new privilege is taken beyond the apt-get
      # the runner preflight above already uses, and release.yml keeps the plain caller with no
      # window manager and no supervisor at all.
      - name: Install the CI-only window manager for the owned display experiment
        run: |
          set -euo pipefail
          sudo apt-get install -y --no-install-recommends openbox x11-utils
          command -v openbox
          command -v xprop
          command -v python3
`;
// Built by substitution so the CI contract can differ from the release contract in exactly
// two places — the headed caller, and the CI-only window-manager install step inserted
// before it — and in no other byte. `replaceOnce` asserts each target is unique in the
// source and that the replacement changes bytes, so neither can land twice or land
// somewhere else.
const ciBrowserAddition = replaceOnce(
  replaceOnce(browserAddition, approvedHeadedCaller, ciHeadedCaller),
  browserCallerStep, `${ciOpenboxInstall}${browserCallerStep}`);
const approvedBrowser = parse('approved-browser-contract', `jobs:\n${browserAddition}`).jobs['browser-tls'];
const approvedCIBrowser = parse('approved-ci-browser-contract', `jobs:\n${ciBrowserAddition}`).jobs['browser-tls'];
function withoutBrowser(workflow, release) {
  assert.deepEqual(workflow.jobs['browser-tls'], release ? approvedBrowser : approvedCIBrowser,
    'complete approved browser/TLS job, ordered steps and no bypasses');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:browser-tls'], 'node tests/hitl/browser-tls.acceptance.mjs', 'actual browser caller');
  assert.equal(pkg.devDependencies.playwright, '1.58.2', 'locked browser dependency');
  if (release) {
    assert.deepEqual(workflow.jobs.guard.needs, ['browser-tls'], 'guard requires browser success');
    assert.deepEqual(workflow.jobs.publish.needs, ['browser-tls', ...original.jobs.publish.needs, ...ids], 'all original, Windows and browser publish dependencies');
  }
  const copy = structuredClone(workflow);
  delete copy.jobs['browser-tls'];
  if (release) {
    delete copy.jobs.guard.needs;
    copy.jobs.publish.needs = copy.jobs.publish.needs.slice(1);
  }
  return copy;
}
const runSteps = job => job.steps.filter(step => typeof step.run === 'string');
function named(job, name) {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, `unique parsed step: ${name}`);
  return matches[0];
}
const commands = {
  persistence: named(final.jobs[ids[0]], 'Persistence suite must be fully green on win32').run,
  declaration: named(final.jobs[ids[1]], 'package.json must declare Windows out').run,
  init: named(final.jobs[ids[1]], 'bin/init/cli.mjs platform gate must exit 2 on win32').run,
  npm: named(final.jobs[ids[1]], 'U23 — npm ci must refuse on win32 with EBADPLATFORM').run,
  ciPersistence: named(ci.jobs[ids[0]], 'Persistence suite must be fully green on win32').run,
};
// Only the parsed Bash function may differ from the rejected/archived CI block.
// Literal boundaries avoid treating surrounding execution/threshold checks as reader code.
function readerParts(command) {
  const startMarker = 'read_count() {';
  const endMarker = 'PASS="$(read_count pass)"';
  const start = command.indexOf(startMarker);
  const end = command.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'reader boundaries exist');
  assert.equal(command.indexOf(startMarker, start + 1), -1, 'one reader definition');
  assert.equal(command.indexOf(endMarker, end + 1), -1, 'one summary assignment');
  return { prefix: command.slice(0, start), reader: command.slice(start, end), suffix: command.slice(end) };
}
const fixedReader = readerParts(commands.persistence).reader;
const rejectedPersistence = named(rejected.jobs[ids[0]], 'Persistence suite must be fully green on win32').run;
writeFileSync(join(evidence, 'parsed-commands.json'), JSON.stringify(commands, null, 2));
for (const [key, command] of Object.entries(commands)) {
  const path = join(admin, `${key}.bash`);
  writeFileSync(path, command);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n', path], { encoding: 'utf8', timeout });
  invocations.push({ kind: 'bash-syntax', executable: bash, argv: ['--noprofile', '--norc', '-n', path], timeout, exit: result.status });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function validate(workflow) {
  workflow = withoutBrowser(workflow, true);
  const top = structuredClone(workflow);
  delete top.jobs;
  const oldTop = structuredClone(original);
  delete oldTop.jobs;
  assert.deepEqual(top, oldTop, 'unchanged trigger, permissions and concurrency');
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...Object.keys(original.jobs), ...ids].sort());
  const guard = structuredClone(workflow.jobs.guard);
  const securityEnv = named(guard, 'Release planning and changed-file admission').env;
  assert.equal(securityEnv.RELEASE_SECURITY_POLICY_SHA256, 'UNREVIEWED');
  assert.equal(securityEnv.RELEASE_SECURITY_COMMIT, '${{ github.sha }}');
  delete securityEnv.RELEASE_SECURITY_POLICY_SHA256;
  delete securityEnv.RELEASE_SECURITY_COMMIT;
  assert.deepEqual(guard, original.jobs.guard, 'guard changes only the required security trust inputs');
  for (const id of ['test', 'windows-declared-unsupported']) {
    assert.deepEqual(workflow.jobs[id], original.jobs[id], `unchanged ${id}`);
  }
  const guardSteps = workflow.jobs.guard.steps;
  const admission = guardSteps.indexOf(named(workflow.jobs.guard, 'Release planning and changed-file admission'));
  const token = guardSteps.indexOf(named(workflow.jobs.guard, 'NPM_TOKEN must be present'));
  assert.ok(admission >= 0 && admission < token, 'admission precedes token');
  const publish = structuredClone(workflow.jobs.publish);
  assert.deepEqual(publish.needs, [...original.jobs.publish.needs, ...ids], 'all publish dependencies');
  publish.needs = original.jobs.publish.needs;
  assert.deepEqual(publish, original.jobs.publish, 'unchanged publish steps, secrets and permissions');
  for (const [index, id] of ids.entries()) {
    const job = workflow.jobs[id];
    assert.equal(job['runs-on'], 'windows-latest');
    assert.equal(job.needs, 'guard');
    assert.equal(job['timeout-minutes'], [20, 10][index]);
    assert.equal(job.steps[0].uses, 'actions/checkout@v4');
    assert.equal(job.steps[1].uses, 'actions/setup-node@v4');
    assert.equal(job.steps[1].with['node-version'], '20');
    assert.equal(job.steps.length, 5);
    const expected = runSteps(ci.jobs[id]).slice(0, 3);
    const actualCommands = runSteps(job).map(s => s.run);
    if (id === 'windows-persistence') {
      const current = readerParts(actualCommands[2]);
      const previous = readerParts(rejectedPersistence);
      assert.equal(current.reader, fixedReader, 'only the frozen corrected reader is authorized');
      assert.equal(current.prefix, previous.prefix, 'W1 pre-reader bytes unchanged');
      assert.equal(current.suffix, previous.suffix, 'W1 post-reader bytes unchanged');
      assert.equal(rejectedPersistence, runSteps(ciBefore.jobs[id])[2].run, 'rejected W1 remains exact archived CI source');
    }
    assert.deepEqual(actualCommands, expected.map(s => s.run), `${id}: exact full CI command parity`);
    for (const item of [job, ...job.steps]) {
      for (const key of ['continue-on-error', 'if', 'strategy', 'env']) {
        assert.ok(!(key in item), `${id}: no ${key} override/bypass`);
      }
    }
    for (const step of runSteps(job)) assert.equal(step.shell, 'bash');
  }
  const forced = ids.flatMap(id => runSteps(workflow.jobs[id]).filter(s => /--force\b/.test(s.run)).map(s => [id, s.run]));
  assert.deepEqual(forced, [['windows-persistence', 'npm ci --force']]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).os, ['darwin', 'linux']);
}

function acceptance(name, category, run) {
  const item = { name, category, status: 'pending' };
  manifest.push(item);
  test(name, { timeout: 15000 }, () => {
    try { run(); item.status = 'pass'; }
    catch (error) { item.status = 'fail'; item.error = error.message; throw error; }
  });
}
acceptance('baseline has zero actual Windows gates and omits both publish dependencies', 'baseline', () => {
  assert.equal(Object.values(original.jobs).filter(j => j['runs-on'] === 'windows-latest').length, 0);
  for (const id of ids) {
    assert.ok(!(id in original.jobs));
    assert.ok(!original.jobs.publish.needs.includes(id));
  }
  assert.throws(() => validate(original));
});
acceptance('frozen final workflow preserves old behavior and requires W0 plus W1', 'structure', () => validate(final));
function validateReleaseHistory(workflow) {
  validate(workflow);
  const copy = withoutBrowser(workflow, true);
  const env = named(copy.jobs.guard, 'Release planning and changed-file admission').env;
  delete env.RELEASE_SECURITY_POLICY_SHA256;
  delete env.RELEASE_SECURITY_COMMIT;
  named(copy.jobs[ids[0]], 'Persistence suite must be fully green on win32').run = rejectedPersistence;
  assert.deepEqual(copy, rejected);
}
acceptance('corrected reader is the only parsed workflow change from rejected source', 'reader-structure', () => validateReleaseHistory(final));
function validateCIHistory(source, historicalSource = readFileSync(join(root, fixtureRoot, 'ci.before-parity.yml'), 'utf8')) {
  const workflow = parse('CI historical comparison', source);
  const persistence = named(workflow.jobs[ids[0]], 'Persistence suite must be fully green on win32').run;
  assert.equal(persistence, commands.persistence);
  assert.equal(sha(persistence), '50b8b702d34566ab8ef1b3ec310770ee5c32af62950d8d7ddb0996e234df6850');
  const copy = withoutBrowser(workflow, false);
  named(copy.jobs[ids[0]], 'Persistence suite must be fully green on win32').run = rejectedPersistence;
  assert.deepEqual(copy, ciBefore);
  const indentReader = reader => reader.split('\n').map(line => line ? '          ' + line : '').join('\n');
  const fixedBytes = indentReader(fixedReader);
  const oldBytes = indentReader(readerParts(rejectedPersistence).reader);
  const bytes = lf(source);
  const addition = `jobs:\n${ciBrowserAddition}`;
  assert.equal(bytes.split(addition).length, 2, 'exactly one approved browser block at the jobs boundary');
  const currentBytes = bytes.replace(addition, 'jobs:\n');
  assert.equal(currentBytes.split(fixedBytes).length, 2, 'exactly one corrected reader in CI YAML');
  assert.equal(currentBytes.replace(fixedBytes, oldBytes), lf(historicalSource), 'inverse reader replacement preserves every other CI byte, including full-suite debt');
}
acceptance('CI W1 matches release and every other CI byte remains unchanged', 'ci-parity', () => validateCIHistory(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')));

const mutants = [];
for (const id of ids) {
  mutants.push([`remove ${id}`, w => { delete w.jobs[id]; }]);
  mutants.push([`remove publish dependency ${id}`, w => { w.jobs.publish.needs = w.jobs.publish.needs.filter(n => n !== id); }]);
  for (const [label, change] of [
    ['wrong runner', j => { j['runs-on'] = 'ubuntu-latest'; }],
    ['missing guard dependency', j => { delete j.needs; }],
    ['missing timeout', j => { delete j['timeout-minutes']; }],
    ['Node 22', j => { j.steps[1].with['node-version'] = '22'; }],
    ['continue-on-error job', j => { j['continue-on-error'] = true; }],
    ['always job', j => { j.if = '${{ always() }}'; }],
    ['skip job', j => { j.if = 'false'; }],
    ['continue-on-error step', j => { j.steps[4]['continue-on-error'] = true; }],
    ['always step', j => { j.steps[4].if = '${{ always() }}'; }],
    ['missing Bash', j => { delete j.steps[4].shell; }],
    ['no-op command', j => { j.steps[4].run = 'echo green'; }],
  ]) mutants.push([`${id}: ${label}`, w => change(w.jobs[id])]);
}
mutants.push(['publish always bypass', w => { w.jobs.publish.if = '${{ always() }}'; }]);
mutants.push(['publish continue-on-error', w => { w.jobs.publish['continue-on-error'] = true; }]);
mutants.push(['W0 forced npm', w => { w.jobs[ids[1]].steps[4].run = 'npm ci --force'; }]);
mutants.push(['changed trigger', w => { w.on.workflow_dispatch = null; }]);
mutants.push(['changed permissions', w => { w.permissions.contents = 'write'; }]);
mutants.push(['admission after token', w => { w.jobs.guard.steps.reverse(); }]);
mutants.push(['W1 changed pass floor outside reader', w => { w.jobs[ids[0]].steps[4].run = commands.persistence.replace('-gt 20', '-gt 0'); }]);
mutants.push(['W1 changed selected test glob outside reader', w => { w.jobs[ids[0]].steps[4].run = commands.persistence.replace('persistence/*.test.js', '*.test.js'); }]);
mutants.push(['W1 reverted legacy reader', w => { w.jobs[ids[0]].steps[4].run = rejectedPersistence; }]);
for (const [name, mutate] of mutants) acceptance(`mutant rejected: ${name}`, 'mutant', () => {
  const copy = structuredClone(final);
  mutate(copy);
  assert.throws(() => validate(copy));
});

const persistenceFiles = readdirSync(join(root, 'tests/session/persistence')).filter(n => n.endsWith('.test.ts')).sort();
assert.ok(persistenceFiles.length > 0);
const persistenceArgv = ['--test', ...persistenceFiles.map(n => `dist/tests/session/persistence/${n.replace(/\.ts$/, '.js')}`)];
const argvByCommand = {
  persistence: persistenceArgv,
  ciPersistence: persistenceArgv,
  declaration: ['-p', "JSON.stringify(require('./package.json').os)"],
  init: ['bin/init/cli.mjs', 'init'],
  npm: ['ci'],
};
function execute(key, fixture, label) {
  const directory = mkdtempSync(join(admin, `${key}-`));
  const bin = join(directory, 'mock-bin');
  mkdirSync(bin);
  for (const utility of utilityNames) symlinkSync(utilities[utility], join(bin, utility));
  const script = `#!${bash}\nprintf '%s\\0' "$0" "$@" >> "$FIXTURE_RECORD"\nwhile IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$FIXTURE_OUTPUT"\nexit "$FIXTURE_EXIT"\n`;
  for (const executable of ['node', 'npm']) {
    const path = join(bin, executable);
    writeFileSync(path, script, { mode: 0o700 });
  }
  // The expanded files are also test-owned scripts; no compiled/product file is run.
  for (const file of persistenceArgv.slice(1)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script, { mode: 0o700 });
  }
  const output = join(directory, 'fixture.out');
  const record = join(directory, 'argv.nul');
  writeFileSync(output, fixture.output);
  const argv = ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', commands[key]];
  const result = spawnSync(bash, argv, {
    cwd: directory, encoding: 'utf8', timeout,
    env: { PATH: bin, RUNNER_TEMP: directory, TMPDIR: directory, LC_ALL: 'C',
      FIXTURE_OUTPUT: output, FIXTURE_RECORD: record, FIXTURE_EXIT: String(fixture.exit) },
  });
  const invocation = { kind: key, label, directory, executable: bash, argv,
    timeout, fixture, exit: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  invocations.push(invocation);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const recorded = readFileSync(record, 'utf8').split('\0');
  assert.equal(recorded.pop(), '');
  invocation.mockArgv = recorded;
  assert.deepEqual(recorded, [join(bin, key === 'npm' ? 'npm' : 'node'), ...argvByCommand[key]], 'one exact test-owned command invocation');
  return result.status;
}
const tap = (pass = 21, fail = 0, skip = 0) => `TAP version 13\n1..${Number(pass) + Number(fail) + Number(skip)}\n# tests ${Number(pass) + Number(fail) + Number(skip)}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skip}\n`;
const cases = [];
const add = (key, name, output, exit, accept = false) => cases.push({ key, name, output, exit, accept });
add('persistence', 'minimum non-vacuous success 21', tap(), 0, true);
add('persistence', 'larger success 42', tap(42), 0, true);
for (const pass of [0, 1, 20, -1]) add('persistence', `reject ${pass} passes`, tap(pass), 0);
add('persistence', 'reject one failed test', tap(21, 1), 0);
add('persistence', 'reject one skipped test', tap(21, 0, 1), 0);
for (const exit of [1, 2, 127]) add('persistence', `reject good counts with runner exit ${exit}`, tap(), exit);
add('persistence', 'reject empty output', '', 0);
for (const field of ['pass', 'fail', 'skipped']) {
  add('persistence', `reject missing ${field}`, tap().split('\n').filter(l => !l.startsWith(`# ${field} `)).join('\n'), 0);
  add('persistence', `reject nonnumeric ${field}`, tap().replace(new RegExp(`# ${field} \\d+`), `# ${field} nope`), 0);
  add('persistence', `reject empty ${field}`, tap().replace(new RegExp(`# ${field} \\d+`), `# ${field} `), 0);
  add('persistence', `reject trailing garbage in ${field}`, tap().replace(new RegExp(`(# ${field} \\d+)`), '$1 garbage'), 0);
}
add('persistence', 'reject decimal passes', tap('21.5'), 0);
add('persistence', 'reject contradictory duplicate fail summary', tap(21, 1) + '# fail 0\n', 0);
add('persistence', 'reject contradictory duplicate skip summary', tap(21, 0, 1) + '# skipped 0\n', 0);
add('declaration', 'accept declared unsupported OS list', '["darwin","linux"]\n', 0, true);
for (const output of ['["darwin","linux","win32"]', '["linux","darwin"]', '[]', '', 'null']) {
  add('declaration', `reject wrong declaration ${JSON.stringify(output)}`, output, 0);
}
add('declaration', 'reject correct declaration with command failure', '["darwin","linux"]\n', 1);
const refusal = 'aigentry-orchestrator does not support Windows natively. Run init inside WSL2.\n';
add('init', 'accept documented refusal exit 2', refusal, 2, true);
for (const exit of [0, 1, 3, 127]) add('init', `reject refusal with exit ${exit}`, refusal, exit);
for (const [name, output] of [
  ['empty message', ''], ['generic error', 'fatal error'],
  ['missing WSL2', 'does not support Windows natively'], ['missing native refusal', 'use WSL2'],
]) add('init', `reject ${name}`, output, 2);
add('npm', 'accept EBADPLATFORM exit 1', 'npm error code EBADPLATFORM\n', 1, true);
add('npm', 'accept EBADPLATFORM exit 2', 'npm error code EBADPLATFORM\n', 2, true);
add('npm', 'reject success despite EBADPLATFORM text', 'npm error code EBADPLATFORM\n', 0);
add('npm', 'reject empty successful install', '', 0);
for (const [name, output] of [['network', 'npm error code ENETUNREACH'], ['auth', 'npm error code E401'], ['generic', 'npm error failure'], ['empty failure', '']]) {
  add('npm', `reject ${name} without EBADPLATFORM`, output, 1);
}
// Retest additions leave every original fixture and its expectation unchanged.
add('persistence', 'accept CRLF summary', tap().replaceAll('\n', '\r\n'), 0, true);
add('persistence', 'accept mixed LF and CRLF summary', tap().replace('# fail 0\n', '# fail 0\r\n'), 0, true);
for (const field of ['pass', 'fail', 'skipped']) {
  const value = field === 'pass' ? '21' : '0';
  const record = `# ${field} ${value}`;
  add('persistence', `reject identical duplicate ${field}`, tap() + record + '\n', 0);
  add('persistence', `reject malformed ${field} before valid`, `# ${field} nope\n` + tap(), 0);
  add('persistence', `reject malformed ${field} after valid`, tap() + `# ${field} nope\n`, 0);
  for (const [label, replacement] of [
    ['negative value', `# ${field} -1`],
    ['explicit plus sign', `# ${field} +${value}`],
    ['decimal value', `# ${field} ${value}.0`],
    ['trailing whitespace', record + ' '],
    ['tab separator', `# ${field}\t${value}`],
    ['double-space separator', `# ${field}  ${value}`],
    ['bare key', `# ${field}`],
    ['double terminal CR', record + '\r\r'],
  ]) add('persistence', `reject ${label} for ${field}`, tap().replace(record, replacement), 0);
  for (const [label, replacement] of [
    ['quoted record', `"${record}"`],
    ['prose record', `diagnostic: ${record}`],
    ['indented record', `  ${record}`],
    ['neighbor key', `# ${field}_other ${value}`],
  ]) add('persistence', `reject missing ${field} despite ${label}`, tap().replace(record, replacement), 0);
  const noise = [`"# ${field} 999"`, `diagnostic: # ${field} 999`, `  # ${field} 999`, `# ${field}_other 999`].join('\n') + '\n';
  add('persistence', `accept ${field} with unrelated quoted prose indented and neighbor-key noise`, noise + tap() + noise, 0, true);
}
for (const item of cases) acceptance(`${item.key}: ${item.name}`, 'runtime', () => {
  const exit = execute(item.key, item, item.name);
  assert.equal(exit === 0, item.accept, `${item.key}: fixture must ${item.accept ? 'accept' : 'reject'}; actual exit ${exit}`);
});
const ciReplayFixtures = [
  'minimum non-vacuous success 21',
  'reject trailing garbage in pass',
  'reject trailing garbage in fail',
  'reject trailing garbage in skipped',
  'reject contradictory duplicate fail summary',
  'reject contradictory duplicate skip summary',
].map(name => {
  const fixture = cases.find(item => item.key === 'persistence' && item.name === name);
  assert.ok(fixture, `existing exact CI replay fixture: ${name}`);
  return fixture;
});
for (const fixture of ciReplayFixtures) acceptance(`CI W1 replay: ${fixture.name}`, 'ci-runtime', () => {
  const exit = execute('ciPersistence', fixture, fixture.name);
  assert.equal(exit === 0, fixture.accept, `CI W1 must ${fixture.accept ? 'accept' : 'reject'}; actual exit ${exit}`);
});
for (const [key, fixture] of [
  ['declaration', { output: '["win32"]', exit: 0 }],
  ['init', { output: 'generic error', exit: 2 }],
  ['npm', { output: 'npm error E401', exit: 1 }],
]) acceptance(`W0 dependent group refuses after failed ${key}`, 'dependent-group', () => {
  const executed = [];
  for (const command of ['declaration', 'init', 'npm']) {
    const input = command === key ? fixture : cases.find(c => c.key === command && c.accept);
    executed.push(command);
    if (execute(command, input, `dependent-group-${key}`) !== 0) break;
  }
  assert.deepEqual(executed, ['declaration', 'init', 'npm'].slice(0, ['declaration', 'init', 'npm'].indexOf(key) + 1));
});

// Portable prerequisite regressions use only private test-owned paths.
const portableBin = join(admin, 'portable tools with spaces');
mkdirSync(portableBin);
const requiredTools = { ruby, bash, ...utilities };
for (const [name, executable] of Object.entries(requiredTools)) symlinkSync(executable, join(portableBin, name));
const overrideFor = name => name === 'ruby' ? 'WINDOWS_GATE_RUBY' : name === 'bash' ? 'WINDOWS_GATE_BASH' : 'WINDOWS_GATE_UTILS';
for (const name of Object.keys(requiredTools)) {
  acceptance(`portable PATH resolves ${name} through a directory containing spaces`, 'portable-path', () => {
    assert.equal(resolveTool(name, overrideFor(name), { PATH: portableBin }), requiredTools[name]);
  });
  acceptance(`portable explicit override resolves ${name} without PATH`, 'portable-path', () => {
    const override = overrideFor(name);
    assert.equal(resolveTool(name, override, { PATH: '', [override]: override === 'WINDOWS_GATE_UTILS' ? portableBin : join(portableBin, name) }), requiredTools[name]);
  });
  acceptance(`portable missing ${name} refuses without skipping`, 'portable-path', () => {
    assert.throws(() => resolveTool(name, overrideFor(name), { PATH: admin }), new RegExp(`Missing prerequisite ${name}`));
  });
}
acceptance('portable unusable explicit override refuses instead of falling back to PATH', 'portable-path', () => {
  for (const name of Object.keys(requiredTools)) {
    assert.throws(() => resolveTool(name, overrideFor(name), { PATH: portableBin, [overrideFor(name)]: join(admin, 'absent') }), /unusable override/);
  }
});
acceptance('portable malformed explicit paths refuse clearly', 'portable-path', () => {
  for (const value of ['', 'relative', `${admin}\ninvalid`]) {
    assert.throws(() => configured('WINDOWS_GATE_EVIDENCE', { WINDOWS_GATE_EVIDENCE: value }), /absolute path required/);
  }
});
acceptance('portable directories and nonexecutable files cannot satisfy prerequisites', 'portable-path', () => {
  const directory = join(admin, 'not-an-executable');
  mkdirSync(directory);
  const file = join(admin, 'not-executable.bash');
  writeFileSync(file, 'exit 0\n', { mode: 0o600 });
  for (const candidate of [directory, file]) {
    assert.throws(() => resolveTool('bash', 'WINDOWS_GATE_BASH', { WINDOWS_GATE_BASH: candidate }), /Missing prerequisite bash/);
  }
});
acceptance('portable default evidence stays inside the private OS temporary directory', 'portable-path', () => {
  assert.equal(dirname(admin), tmpdir());
  assert.equal(statSync(admin).mode & 0o777, 0o700);
  if (process.env.WINDOWS_GATE_EVIDENCE === undefined) {
    assert.equal(evidence, join(admin, 'evidence'));
    assert.equal(statSync(evidence).mode & 0o777, 0o700);
  }
});

// Actual runner discovery/chaining regressions. Every copied runner sees only
// synthetic compiled files and sentinels at the explicit security and harness paths.
const callerSource = readFileSync(join(root, 'scripts/run-tests.mjs'), 'utf8');
const staleGuardSource = readFileSync(join(root, 'scripts/stale-dist-guard.mjs'), 'utf8');
const harnessRelative = 'tests/packaging/windows-release-gates.test.mjs';
const securityRelative = 'tests/hitl/snyk-boundaries.test.mjs';
const admissionRelative = 'tests/packaging/release-admission.test.mjs';
const nativeRelative = 'tests/packaging/native-capture.test.mjs';
function callerFixture(mode, symlinked = false) {
  const directory = mkdtempSync(join(admin, 'caller fixture '));
  const put = (path, source) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  };
  put('package.json', '{"type":"module"}\n');
  put('scripts/run-tests.mjs', callerSource);
  put('scripts/stale-dist-guard.mjs', staleGuardSource);
  assert.equal(sha(readFileSync(join(directory, 'scripts/run-tests.mjs'))), sha(callerSource));
  const checks = `import assert from 'node:assert/strict';\nassert.equal(process.cwd(), process.env.CALLER_EXPECTED_CWD);\nassert.equal(process.execPath, process.env.CALLER_EXPECTED_NODE);\nassert.equal(process.env.CALLER_ENV, 'inherited');\n`;
  const compiled = checks + `console.log('CALLER_COMPILED_CONTROL');\nprocess.exit(${mode === 'compiled-fail' ? 7 : 0});\n`;
  if (mode !== 'missing-dist') mkdirSync(join(directory, 'dist/tests'), { recursive: true });
  if (!['missing-dist', 'empty'].includes(mode)) {
    put('dist/tests/control.test.js', compiled);
    if (mode !== 'stale-test') put('tests/control.test.ts', compiled);
  }
  if (mode === 'stale-helper') put('dist/tests/orphan.js', '// synthetic stale helper\n');
  if (mode !== 'missing-security') put(securityRelative, checks + `assert.equal(new URL(import.meta.url).pathname.endsWith('/${securityRelative}'), true);\nconsole.log('CALLER_SECURITY_SENTINEL');\nprocess.exit(${mode === 'failing-security' ? 8 : 0});\n`);
  if (mode !== 'missing-admission') put(admissionRelative, checks + `console.log('CALLER_ADMISSION_SENTINEL');\nprocess.exit(${mode === 'failing-admission' ? 8 : 0});\n`);
  if (mode !== 'missing-native') put(nativeRelative, checks + `console.log('CALLER_NATIVE_SENTINEL');\nprocess.exit(${mode === 'failing-native' ? 8 : 0});\n`);
  if (mode !== 'missing-harness') put(harnessRelative, checks + `console.log('CALLER_SOURCE_SENTINEL');\nprocess.exit(${mode === 'sentinel-fail' ? 9 : 0});\n`);
  put('tests/packaging/unselected.test.mjs', "console.log('CALLER_UNSELECTED_MJS'); process.exit(99);\n");
  if (symlinked) {
    const alias = `${directory} symlink`;
    symlinkSync(realpathSync(directory), alias);
    assert.notEqual(alias, realpathSync(alias), 'regression must exercise a distinct symlink spelling');
    return alias;
  }
  return directory;
}
for (const symlinked of [false, true]) {
for (const [mode, expected, compiled, security, sentinel, diagnostic] of [
  ['pass', 0, true, true, true],
  ['sentinel-fail', 1, true, true, true, /POSIX control harness failed with exit status: 1/],
  ['compiled-fail', 1, true, true, false],
  ['missing-security', 1, false, false, false, /tests[\\/]hitl[\\/]snyk-boundaries\.test\.mjs/],
  ['failing-security', 1, true, true, false],
  ['missing-admission', 1, false, false, false, /tests[\\/]packaging[\\/]release-admission\.test\.mjs/],
  ['failing-admission', 1, true, true, false],
  ['missing-native', 1, false, false, false, /tests[\\/]packaging[\\/]native-capture\.test\.mjs/],
  ['failing-native', 1, true, true, false],
  ['missing-harness', 1, true, true, false, /POSIX control harness failed with exit status: 1/],
  ['empty', 1, false, false, false, /No compiled test files found/],
  ['missing-dist', 1, false, false, false, /Failed to enumerate compiled tests/],
  ['stale-test', 1, false, false, false, /stale compiled test: dist\/tests\/control.test.js/],
  ['stale-helper', 1, false, false, false, /stale compiled helper: dist\/tests\/orphan.js/],
]) acceptance(`caller actual subprocess: ${mode}${symlinked ? ' through symlink' : ''}`, 'caller-actual', () => {
  const directory = callerFixture(mode, symlinked);
  const argv = ['scripts/run-tests.mjs'];
  const env = { PATH: '', TMPDIR: directory, CALLER_ENV: 'inherited',
    // Node resolves the runner's ESM root and cwd through symlinked temporary paths.
    CALLER_EXPECTED_CWD: realpathSync(directory), CALLER_EXPECTED_NODE: process.execPath };
  const result = spawnSync(process.execPath, argv, { cwd: directory, env, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-actual', label: mode, symlinked, executable: process.execPath, argv,
    cwd: directory, env, timeout, exit: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected);
  assert.equal(result.stdout.includes('CALLER_COMPILED_CONTROL'), compiled);
  assert.equal(result.stdout.includes('CALLER_SECURITY_SENTINEL'), security);
  assert.equal(result.stdout.includes('CALLER_SOURCE_SENTINEL'), sentinel);
  assert.equal(result.stdout.includes('CALLER_ADMISSION_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_NATIVE_SENTINEL'), compiled);
  assert.ok(!result.stdout.includes('CALLER_UNSELECTED_MJS'), 'no automatic source .mjs discovery');
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_COMPILED_CONTROL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (security && sentinel) assert.ok(result.stdout.indexOf('CALLER_SECURITY_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_NATIVE_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (diagnostic) assert.match(result.stderr, diagnostic);
});
}

// The test-only subprocess links exact, unmodified runner ESM to builtin mocks.
// No source rewriting and no claim that a mocked platform ran natively.
async function callerVMDriver() {
  const assert = (await import('node:assert/strict')).default;
  const { readFileSync } = await import('node:fs');
  const { createContext, SourceTextModule, SyntheticModule } = await import('node:vm');
  const paths = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const result of config.results) {
    assert.ok(result.status === null || Number.isInteger(result.status));
    assert.ok(result.signal === null || typeof result.signal === 'string');
    assert.ok(!(result.signal && result.status !== null), 'impossible mock: numeric exit status with terminating signal');
    assert.ok(!(result.error && result.status !== null), 'impossible mock: startup/timeout error with numeric exit status');
    assert.ok(result.status !== null || result.signal || result.error, 'mock null status needs signal or error');
  }
  const path = config.platform === 'win32' ? paths.win32 : paths.posix;
  const root = config.platform === 'win32' ? 'C:\\test-owned\\caller' : '/test-owned/caller';
  const runnerPath = path.join(root, 'scripts', 'run-tests.mjs');
  const calls = [], logs = [], errors = [];
  const exit = {};
  let status;
  const context = createContext({ process: { execPath: process.execPath, platform: config.platform,
    env: { CALLER_ENV: 'inherited' }, exit(code) { status = code; throw exit; } },
    console: { log(...args) { logs.push(args.join(' ')); }, error(...args) { errors.push(args.join(' ')); } } });
  const entry = (name, directory = false) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const modules = {
    'node:child_process': { spawnSync(executable, argv, options) {
      calls.push({ executable, argv: Array.from(argv), options: { ...options } });
      assert.ok(calls.length <= config.results.length, 'unexpected subprocess');
      const result = config.results[calls.length - 1];
      return { ...result, error: result.error ? Object.assign(new Error(result.error), { code: result.code }) : undefined };
    } },
    'node:fs': { readdirSync(directory, options) {
      assert.equal(options.withFileTypes, true);
      if (config.discovery === 'missing') throw new Error('synthetic ENOENT');
      if (config.discovery === 'empty') return [];
      if (directory === path.join(root, 'dist', 'tests')) return [entry('z.test.js'), entry('nested', true), entry('unselected.test.mjs'), entry('a.test.js')];
      assert.equal(directory, path.join(root, 'dist', 'tests', 'nested'));
      return [entry('b.test.js')];
    } },
    'node:path': Object.fromEntries(['dirname', 'join', 'relative', 'resolve', 'sep'].map(key => [key, path[key]])),
    'node:url': { fileURLToPath: () => runnerPath },
    './stale-dist-guard.mjs': { findStaleCompiled(directory) { assert.equal(directory, root); return config.stale ?? []; } },
  };
  const module = new SourceTextModule(config.source, { context, identifier: pathToFileURL(runnerPath).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(runnerPath).href; } });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(modules, specifier), `unexpected import ${specifier}`);
    const exports = modules[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  try { await module.evaluate({ timeout: 1000 }); } catch (error) { if (error !== exit) throw error; }
  assert.notEqual(status, undefined, 'runner must exit');
  process.stdout.write(JSON.stringify({ status, calls, logs, errors, root, executable: process.execPath }));
}
const driver = join(admin, 'caller-vm-driver.mjs');
writeFileSync(driver, `(${callerVMDriver.toString()})().catch(error => { console.error(error); process.exit(1); });\n`);
const success = { status: 0, signal: null };
const failed = { status: 7, signal: null };
const signaled = { status: null, signal: 'SIGTERM' };
const startupError = { status: null, signal: null, error: 'synthetic ENOENT', code: 'ENOENT' };
const timedOut = { status: null, signal: 'SIGKILL', error: 'synthetic ETIMEDOUT', code: 'ETIMEDOUT' };
const vmCases = [];
for (const platform of ['linux', 'darwin']) {
  vmCases.push({ name: `${platform} compiled/security/admission/native success then exact harness invocation`, platform, results: [success, success], status: 0, calls: 2 });
  for (const [name, result, diagnostic] of [
    ['nonzero', failed, /exit status: 7/], ['startup error', startupError, /POSIX control harness failed: synthetic ENOENT/],
    ['signal', signaled, /terminated by signal: SIGTERM/], ['timeout', timedOut, /POSIX control harness failed: synthetic ETIMEDOUT/],
  ]) vmCases.push({ name: `${platform} harness ${name} refuses`, platform, results: [success, result], status: result.status ?? 1, calls: 2, diagnostic });
}
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const [name, result, status] of [['nonzero', failed, 7], ['startup error', startupError, 1], ['signal', signaled, 1]]) {
    vmCases.push({ name: `${platform} initial test composition ${name} prevents harness`, platform, results: [result], status, calls: 1 });
  }
}
vmCases.push({ name: 'win32 success preserves compiled result and prints non-TAP notice', platform: 'win32', results: [success], status: 0, calls: 1 });
vmCases.push({ name: 'unknown host refuses after compiled success', platform: 'freebsd', results: [success], status: 1, calls: 1, diagnostic: /unavailable on unsupported platform: freebsd/ });
for (const [discovery, diagnostic] of [['empty', /No compiled test files found/], ['missing', /Failed to enumerate compiled tests/]]) {
  vmCases.push({ name: `${discovery} discovery refuses without spawning`, platform: 'linux', discovery, results: [], status: 1, calls: 0, diagnostic });
}
vmCases.push({ name: 'stale compiled refuses without spawning', platform: 'linux', stale: ['stale compiled test: synthetic'], results: [], status: 1, calls: 0, diagnostic: /Nothing was run/ });
vmCases.push({ name: 'impossible numeric-status-plus-signal mock is rejected before runner execution', platform: 'linux', results: [{ status: 0, signal: 'SIGTERM' }], invalid: /impossible mock: numeric exit status with terminating signal/ });
for (const item of vmCases) acceptance(`caller VM: ${item.name}`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-${vmCases.indexOf(item)}.json`);
  writeFileSync(config, JSON.stringify({ ...item, source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  const invocation = { kind: 'caller-vm', label: item.name, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
    runnerSha256: sha(callerSource), scenario: { ...item, diagnostic: item.diagnostic?.source, invalid: item.invalid?.source } };
  invocations.push(invocation);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, item.invalid ? 1 : 0);
  if (item.invalid) { assert.match(result.stderr, item.invalid); return; }
  const actual = JSON.parse(result.stdout);
  invocation.observed = actual;
  assert.equal(actual.status, item.status);
  assert.equal(actual.calls.length, item.calls);
  if (item.calls > 0) assert.deepEqual(actual.calls[0], { executable: process.execPath,
    argv: ['--test', 'dist/tests/a.test.js', 'dist/tests/nested/b.test.js', 'dist/tests/z.test.js', securityRelative, admissionRelative,
      ...(['linux', 'darwin'].includes(item.platform) ? [nativeRelative] : [])],
    options: { cwd: actual.root, stdio: 'inherit' } });
  if (item.calls === 2) assert.deepEqual(actual.calls[1], { executable: process.execPath,
    argv: ['--test', harnessRelative], options: { cwd: actual.root, stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL' } });
  if (item.platform === 'win32') {
    assert.deepEqual(actual.logs, ['POSIX control harness is not run on win32; native Windows W1/W0 jobs remain separate.']);
    assert.ok(actual.logs.every(line => !/^(#|ok\b|not ok\b|TAP\b|1\.\.)/.test(line)), 'notice must not impersonate TAP results');
  } else assert.deepEqual(actual.logs, []);
  if (item.diagnostic) assert.match(actual.errors.join('\n'), item.diagnostic);
});

// Exercise the same historical validators with private YAML strings. Exact needle
// checks are outside assert.throws so a stale/no-op mutation cannot pass a negative.
function replaceOnce(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `unique mutation target: ${needle}`);
  assert.notEqual(needle, replacement, 'mutation must change bytes');
  return source.replace(needle, () => replacement);
}
// Whole-step slices of the independent approved contract, so the ordering negatives can
// move a step without restating its bytes. Sliced from the contract, never from a
// workflow under test, and each boundary is asserted present and unique.
const browserBlockMarkers = {
  preflight: "      # No new dependency: the step above already pulled Xvfb and xauth in as Chromium's\n",
  caller: browserCallerStep,
  headedRun: '        run: |\n          set -euo pipefail\n          umask 077\n',
  callerTimeout: '        timeout-minutes: 10\n',
  validate: '      - name: Validate complete receipt against this checkout\n',
  receiptUpload: '      - name: Upload sanitized receipt only\n',
  consoleUpload: '      # The six files are enumerated one per line rather than globbed.',
};
function browserBlock(start, end) {
  const from = browserAddition.indexOf(start);
  assert.ok(from >= 0, `approved contract block start: ${start}`);
  assert.equal(browserAddition.indexOf(start, from + 1), -1, `unique contract block start: ${start}`);
  const to = end === undefined ? browserAddition.length : browserAddition.indexOf(end, from);
  assert.ok(to > from, `approved contract block end: ${end}`);
  return browserAddition.slice(from, to);
}
const validateBlock = browserBlock(browserBlockMarkers.validate, browserBlockMarkers.receiptUpload);
const receiptUploadBlock = browserBlock(browserBlockMarkers.receiptUpload, browserBlockMarkers.consoleUpload);
// Drops only the blank line that separates the approved job from the next one.
const consoleUploadBlock = browserBlock(browserBlockMarkers.consoleUpload).replace(/\n$/, '');
// The whole preflight step with its rationale comment, so the negative can delete the tool
// presence check outright instead of restating it.
const preflightBlock = browserBlock(browserBlockMarkers.preflight, browserBlockMarkers.caller);
// The approved headed caller as one indivisible block scalar: safe wrapper, owner-only
// authority cookie and a display that never listens on TCP.
const headedCaller = browserBlock(browserBlockMarkers.headedRun, browserBlockMarkers.callerTimeout);
const umaskLine = '          umask 077\n';
const xvfbLine = '          xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" npm run test:browser-tls\n';
assert.equal(headedCaller, `${browserBlockMarkers.headedRun}${xvfbLine}`, 'approved headed caller is exactly the wrapped npm caller');
assert.equal(headedCaller, approvedHeadedCaller, 'one approved headed caller drives both the contract and the negatives');
// The wrapper invocation itself is byte-identical in both contracts, so the display-control
// negatives below anchor on it directly instead of on the per-workflow caller body.
const xvfbInvocation = 'xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp"';
for (const [label, block] of [['release', xvfbLine], ['CI', ciDiagnosticRun]]) {
  assert.equal(block.split(xvfbInvocation).length, 2, `one wrapper invocation in the ${label} caller`);
}
const consoleEnv = '          CONSOLE_UI_ARTIFACTS: ${{ runner.temp }}/console-ui-artifacts\n';
// The key is identical on both steps, so each negative is anchored to the unique bytes that
// follow it: the headed caller's rationale comment on one, the plain run line on the other.
const consoleEnvSites = [
  ['browser step', '        # Headed Chromium on a private virtual display owned by this non-root ephemeral\n'],
  ['receipt validation step', '        run: npm run test:browser-tls -- --validate-receipt\n'],
];
const consolePaths = ['console-320.png', 'console-390.png', 'console-768.png',
  'console-1440.png', 'console-zoom.png', 'console-ui-receipt.json'];
const consoleReceiptPath = `            \${{ runner.temp }}/console-ui-artifacts/console-ui-receipt.json\n`;
const consoleFirstPath = `            \${{ runner.temp }}/console-ui-artifacts/console-320.png\n`;
const consoleUploadName = '      - name: Upload Console UI evidence\n';
// The caller differs between the two workflows (CI carries the approved diagnostic), so the
// caller-shaped negatives are anchored to the contract of the workflow under test. Every
// other needle is byte-identical in both and stays a plain literal.
const browserMutationsFor = ({ addition, caller, run }) => [
  ['missing browser job', addition, ''],
  ['browser skip', '  browser-tls:\n', '  browser-tls:\n    if: false\n'],
  ['browser always', '  browser-tls:\n', '  browser-tls:\n    if: always()\n'],
  ['browser continue-on-error', '  browser-tls:\n', '  browser-tls:\n    continue-on-error: true\n'],
  ['caller skip', caller, `        if: false\n${caller}`],
  ['caller always', caller, `        if: always()\n${caller}`],
  ['caller continue-on-error', caller, `        continue-on-error: true\n${caller}`],
  ['caller swallowed failure', run, run.replace(/\n$/, ' || true\n')],
  ['caller no-op', caller, '        run: echo green\n'],
  // Headed display controls. The wrapper, its owner-only authority cookie, the disabled X
  // TCP socket and the named preflight are each load-bearing, so each removal or weakening
  // is its own negative rather than being folded into one "caller changed" case.
  ['headed wrapper removed', run, '          npm run test:browser-tls\n'],
  ['headed wrapper replaced by bare display export', run, '          DISPLAY=:99 npm run test:browser-tls\n'],
  ['private cookie umask removed', umaskLine, ''],
  ['private cookie umask widened', umaskLine, '          umask 022\n'],
  ['X authentication disabled', xvfbInvocation,
    'xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp -ac"'],
  ['X authority cookie shared', xvfbInvocation,
    'xvfb-run -a -f /tmp/xauth --server-args="-screen 0 1280x1024x24 -nolisten tcp"'],
  ['display listening on TCP', xvfbInvocation,
    'xvfb-run -a --server-args="-screen 0 1280x1024x24"'],
  ['preflight display tools missing', preflightBlock, ''],
  ['preflight wrapper unchecked', '          command -v xvfb-run\n', ''],
  ['preflight X authority tool unchecked', '          command -v xauth\n', ''],
  ['receipt validation missing', '        run: npm run test:browser-tls -- --validate-receipt\n', '        run: echo green\n'],
  ['receipt validation swallowed failure', '        run: npm run test:browser-tls -- --validate-receipt\n', '        run: npm run test:browser-tls -- --validate-receipt || true\n'],
  ['receipt upload widened', '          path: ${{ runner.temp }}/browser-tls-receipt.json\n', '          path: ${{ runner.temp }}\n'],
  // Both uploads now carry `if-no-files-found: error`, so this negative is anchored to the
  // receipt path above it and still lands exactly one mutation.
  ['missing receipt accepted',
    '          path: ${{ runner.temp }}/browser-tls-receipt.json\n          if-no-files-found: error\n',
    '          path: ${{ runner.temp }}/browser-tls-receipt.json\n          if-no-files-found: ignore\n'],
  ['wrong browser runner', '    runs-on: ubuntu-22.04\n', '    runs-on: windows-latest\n'],
  ['root permitted', '          test "$(id -u)" -ne 0\n', '          true\n'],
  ['hosted runner check missing', '          test "$RUNNER_ENVIRONMENT" = github-hosted\n', '          true\n'],
  ['unlocked install', '          npm ci\n', '          npm install\n'],
  ['unpinned Node', "          node-version: '20.20.0'\n", "          node-version: '20'\n"],
  ['changed Playwright pin', "p.version!=='1.58.2'", "p.version!=='1.58.1'"],
  ['changed Chromium revision', "b.revision!=='1208'", "b.revision!=='1207'"],
  ['changed Chromium version', "b.browserVersion!=='145.0.7632.6'", "b.browserVersion!=='145.0.7632.5'"],
  ['browser install may resolve packages', 'npx --no-install playwright install --with-deps chromium', 'npx playwright install --with-deps chromium'],
  ['checkout credentials retained', '          persist-credentials: false\n', '          persist-credentials: true\n'],
  ['unapproved browser environment', '  browser-tls:\n', '  browser-tls:\n    env:\n      NODE_TLS_REJECT_UNAUTHORIZED: "0"\n'],
  ['unrelated job command', '        run: npm test\n', '        run: echo green\n'],
  ['Windows command changed', 'node --test dist/tests/session/persistence/*.test.js', 'node --test dist/tests/*.test.js'],
  ['Windows threshold changed', '[ "${PASS}" -gt 20 ]', '[ "${PASS}" -gt 0 ]'],
  // Console UI evidence: the artifacts directory must be declared to both steps that write
  // or re-check it, and the upload must stay an exact six-path, success-only publication.
  ...consoleEnvSites.flatMap(([site, anchor]) => [
    [`Console artifacts directory missing on ${site}`, consoleEnv + anchor, anchor],
    [`Console artifacts directory changed on ${site}`, consoleEnv + anchor,
      '          CONSOLE_UI_ARTIFACTS: ${{ runner.temp }}\n' + anchor],
  ]),
  ...consolePaths.map(file => [`Console upload missing ${file}`,
    `            \${{ runner.temp }}/console-ui-artifacts/${file}\n`, '']),
  ['Console upload widened to a wildcard', consoleFirstPath, `            \${{ runner.temp }}/console-ui-artifacts/*\n`],
  ['Console upload widened to the artifacts directory', consoleFirstPath, `            \${{ runner.temp }}/console-ui-artifacts\n`],
  ['Console upload widened to TEMP', consoleFirstPath, `            \${{ runner.temp }}\n`],
  ['missing Console evidence ignored', consoleReceiptPath + '          if-no-files-found: error\n',
    consoleReceiptPath + '          if-no-files-found: ignore\n'],
  ['missing Console evidence merely warned', consoleReceiptPath + '          if-no-files-found: error\n',
    consoleReceiptPath + '          if-no-files-found: warn\n'],
  ['Console upload on failure', consoleUploadName, `${consoleUploadName}        if: always()\n`],
  ['Console upload continue-on-error', consoleUploadName, `${consoleUploadName}        continue-on-error: true\n`],
  ['Console upload before receipt upload', receiptUploadBlock + consoleUploadBlock,
    consoleUploadBlock + receiptUploadBlock],
  ['Console upload before receipt validation', validateBlock + receiptUploadBlock + consoleUploadBlock,
    consoleUploadBlock + validateBlock + receiptUploadBlock],
];
// CI-only. Each negative weakens exactly one of the bounds the wm-shape observation and the
// #1177 owned supervisor were approved under, so a later edit that turns the observation into
// a verdict, that lets the supervisor claim ownership it did not prove, that lets it signal
// something it does not own, or that lets a failure be laundered into a pass, is rejected BY
// NAME rather than only by the blanket byte comparison. The four negatives that used to anchor
// on `exec npm run test:browser-tls` now anchor on the `exec`d supervisor that replaced it; the
// bound each one holds is unchanged.
const ciDiagnosticMutations = [
  // An observation that did not happen must stay `unknown`. Seeding the default as `absent`
  // would report "no window manager" for a probe that never ran.
  ['diagnostic defaults a missing observation to absence', '            ewmh=unknown\n', '            ewmh=absent\n'],
  // The xprop exit status is load-bearing: only a zero exit may be parsed.
  ['diagnostic discards the xprop exit status',
    '              status=$?\n              if [ "$status" -eq 0 ]; then\n',
    '              status=0\n              if [ "$status" -eq 0 ]; then\n'],
  ['diagnostic swallows the xprop failure with ||true',
    '              root=$(timeout 5 xprop -root -notype _NET_SUPPORTING_WM_CHECK 2>/dev/null)\n',
    '              root=$(timeout 5 xprop -root -notype _NET_SUPPORTING_WM_CHECK 2>/dev/null) || true\n'],
  ['diagnostic pipes the read so a SIGPIPE can become the verdict',
    '              root=$(timeout 5 xprop -root -notype _NET_SUPPORTING_WM_CHECK 2>/dev/null)\n',
    '              root=$(xprop -root -notype _NET_SUPPORTING_WM_CHECK 2>/dev/null | head -1)\n'],
  // The probe must stay bounded; an unbounded xprop can hang the 10-minute caller budget.
  ['diagnostic drops the xprop timeout bound', '              root=$(timeout 5 xprop', '              root=$(xprop'],
  // An unrecognized output shape is unknown, not a verdict.
  ['diagnostic treats an unrecognized shape as absence',
    '                  *) ewmh=unknown ;;\n', '                  *) ewmh=absent ;;\n'],
  // The observation authorizes nothing and is read by no check — in particular it may not
  // stand in for the supervisor's own baseline read and readiness proof.
  ['diagnostic is read as a gate on the acceptance run',
    '            exec python3 "$WM_SUPERVISOR"\n',
    '            [ "$ewmh" = present ] || exit 1\n            exec python3 "$WM_SUPERVISOR"\n'],
  // Reporting stays one stderr line; the property VALUE is never printed.
  ['diagnostic reports on stdout where it can be mistaken for results',
    ' "$installed" "$ewmh" >&2\n', ' "$installed" "$ewmh"\n'],
  ['diagnostic prints the raw property value',
    'ewmh-property=%s)\\n" "$installed" "$ewmh" >&2\n', 'ewmh-property=%s)\\n" "$installed" "$root" >&2\n'],
  // The diagnostic observes only: no install, no root and no WM start of its own. Starting a
  // window manager the supervisor does not own would leave a process nothing can stop or join.
  ['diagnostic installs a window manager',
    '            installed=none\n', '            sudo apt-get install -y mutter\n            installed=none\n'],
  ['diagnostic starts a window manager the supervisor does not own',
    '            exec python3 "$WM_SUPERVISOR"\n',
    '            mutter --x11 &\n            exec python3 "$WM_SUPERVISOR"\n'],
  // `exec` is what keeps the step's exit status the supervisor's own, and the supervisor is
  // what keeps that status the acceptance run's own.
  ['diagnostic stops exec-ing the owned supervisor in place',
    '            exec python3 "$WM_SUPERVISOR"\n', '            python3 "$WM_SUPERVISOR"\n'],
  ['diagnostic replaces the owned supervisor with a no-op',
    '            exec python3 "$WM_SUPERVISOR"\n', '            echo green\n'],
  ['diagnostic bypasses the supervisor and runs the suite unsupervised',
    '            exec python3 "$WM_SUPERVISOR"\n', '            exec npm run test:browser-tls\n'],
  ['supervisor is written outside the owner-only runner temp',
    '          export WM_SUPERVISOR="$RUNNER_TEMP/wm-owned-supervisor.py"\n',
    '          export WM_SUPERVISOR=/tmp/wm-owned-supervisor.py\n'],

  // #1177 — the owned supervisor's own bounds. -- THE EXACT PID BINDING IS REQUIRED. This is
  // the defect the previous attempt was rejected for: a supporting window with no readable
  // _NET_WM_PID was still accepted as owned. Missing, malformed, unreadable and foreign each
  // get their own negative, and none of them may resolve to `owned`.
  ['supervisor accepts a supporting window that published no _NET_WM_PID',
    '                  if state == "absent":\n                      return "pid-missing"\n',
    '                  if state == "absent":\n                      return "owned"\n'],
  ['supervisor accepts a malformed _NET_WM_PID',
    '                      return "pid-malformed"\n', '                      return "owned"\n'],
  ['supervisor accepts an unreadable _NET_WM_PID',
    '                      return "pid-unreadable"\n', '                      return "owned"\n'],
  ['supervisor adopts a foreign _NET_WM_PID as the owned pid',
    '                      return "pid-foreign"\n', '                      return "owned"\n'],
  ['supervisor stops reading the exact pid binding at all',
    '                  state, claimed = wm_pid(window, deadline)\n',
    '                  claimed = wm.pid\n'],
  // -- and nothing weaker is accepted in its place --
  ['supervisor accepts a supporting window that does not point back at itself',
    '                  if state != "value" or back != window:\n', '                  if False:\n'],
  ['supervisor accepts a foreign window manager on the owned display',
    '                  if "Openbox" not in name:\n                      return "foreign-wm"\n',
    '                  if "Openbox" in name:\n                      return "owned"\n'],
  ['supervisor adopts a registration that predates it',
    '              if state == "value":\n', '              if False:\n'],
  ['supervisor treats an unreadable initial state as an absent one',
    '              if state != "absent":\n', '              if False:\n'],
  ['supervisor runs on regardless of the owned child dying',
    '                  if wm.poll() is not None:\n                      return "exited"\n'
      + '                  if deadline - time.monotonic() <= 0:\n',
    '                  if deadline - time.monotonic() <= 0:\n'],
  ['supervisor stops re-checking that the owned child outlived the wait',
    '                  if wm.poll() is not None:\n                      return "exited"\n'
      + '                  return "owned"\n',
    '                  return "owned"\n'],
  ['supervisor runs the suite without verified ownership',
    '                  if ready == "owned":\n', '                  if True:\n'],
  ['supervisor stops failing when ownership was never verified',
    '              if ready != "owned":\n', '              if False:\n'],
  // -- readiness stays bounded, and every probe fits inside that one deadline --
  ['supervisor makes the readiness deadline unbounded',
    '              deadline = started + READY_SECONDS\n',
    '              deadline = started + 86400.0\n'],
  ['supervisor drops the per-probe bound that fits the readiness deadline',
    '                                        timeout=min(PROBE_SECONDS, left))\n',
    '                                        timeout=None)\n'],
  // -- one synchronous owner: no watchdog, no numeric pid, no broad kill. This is the second
  // defect the previous attempt was rejected for: a backgrounded `sleep N; kill -9 $pid`
  // watcher could fire on a recycled pid after the parent wait had already reaped the child.
  ['supervisor arms a delayed numeric-pid watchdog beside the owned handle',
    '              child.kill()\n',
    '              subprocess.Popen(["sh", "-c", "sleep 10; kill -9 %d" % child.pid])\n'],
  ['supervisor signals a numeric pid instead of the owned handle',
    '              child.terminate()\n', '              os.kill(child.pid, signal.SIGTERM)\n'],
  ['supervisor scans for processes to kill instead of stopping the owned child',
    '              if child.poll() is not None:\n                  return None\n'
      + '              child.terminate()\n',
    '              subprocess.run(["pkill", "-TERM", "openbox"])\n'],
  ['supervisor joins the owned child unbounded',
    '                  child.wait(timeout=seconds)\n', '                  child.wait()\n'],
  ['supervisor assumes SIGKILL and the join after it can never time out',
    '              if join(child, KILL_SECONDS):\n                  return None\n',
    '              join(child, KILL_SECONDS)\n              return None\n'],
  // -- one cleanup path, reached from every exit and never interrupted part-way --
  ['supervisor loses the single cleanup path every exit funnels into',
    '              finally:\n', '              else:\n'],
  ['supervisor lets a repeated signal interrupt the cleanup it funnels into',
    '                  signal.signal(signal.SIGINT, signal.SIG_IGN)\n'
      + '                  signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
      + '                  owned = 0\n',
    '                  owned = 0\n'],
  // #1177 THE CORRECTED CANCELLATION RACE. The rejected shape raised out of the signal
  // handler whenever cleanup was not yet marked, so a signal delivered in the one-to-two
  // bytecode window between entering `finally` and setting the CLEANING latch unwound
  // straight out of cleanup: the owned Openbox was left running and NO named 128+signal
  // status was produced at all (reproduced 10/10 at that exact seam). The handler is now
  // record-only and the cancellation is acted on by bounded polls at the waits, so each part
  // of that correction is its own negative and a regression is rejected BY NAME rather than
  // only by the blanket byte comparison.
  // -- cancel-before-latch: nothing may raise out of the handler, at any interpreter point --
  ['supervisor raises out of the cancellation handler again so a signal can unwind cleanup',
    '              CANCELLED.append(number)\n',
    '              CANCELLED.append(number)\n              raise KeyboardInterrupt()\n'],
  ['supervisor restores the latch-guarded raise that lost the cleanup and the named status',
    '              CANCELLED.append(number)\n',
    '              CANCELLED.append(number)\n              if not CLEANING:\n'
      + '                  raise KeyboardInterrupt()\n'],
  ['supervisor records no signal for the bounded waits to poll',
    '              CANCELLED.append(number)\n', '              pass\n'],
  ['supervisor reinstates an asynchronous unwind for cleanup to catch',
    '              finally:\n', '              except BaseException:\n                  pass\n'
      + '              finally:\n'],
  // -- cancel during readiness: the readiness loop polls for it and stops on it --
  ['supervisor stops polling for a cancellation during readiness',
    '                  if CANCELLED:\n                      return "cancelled"\n', ''],
  ['supervisor sleeps through a cancellation while waiting for the registration',
    '                      pause(1)   # not registered yet; the deadline above ends this wait\n',
    '                      time.sleep(1)   # not registered yet\n'],
  ['supervisor drops the cancellation poll from the readiness retry pause',
    '              while not CANCELLED:\n                  left = end - time.monotonic()\n',
    '              while True:\n                  left = end - time.monotonic()\n'],
  ['supervisor drops the per-poll bound on the readiness retry pause',
    '                  time.sleep(min(POLL_SECONDS, left))\n',
    '                  time.sleep(seconds)\n'],
  // -- cancel during the suite wait: a bounded poll, never a blocking wait --
  ['supervisor blocks in the suite wait where a recorded cancellation cannot be observed',
    '                      suite_rc = await_owned(suite)\n',
    '                      suite_rc = suite.wait()\n'],
  ['supervisor drops the cancellation poll from the owned suite wait',
    '              while not CANCELLED:\n                  try:\n',
    '              while True:\n                  try:\n'],
  ['supervisor makes the owned suite wait unbounded so the poll never comes round',
    '                      return child.wait(timeout=POLL_SECONDS)\n',
    '                      return child.wait()\n'],
  ['supervisor signals the owned suite from the wait instead of the one cleanup path',
    '                  except subprocess.TimeoutExpired:\n                      continue\n'
      + '              return None\n',
    '                  except subprocess.TimeoutExpired:\n                      continue\n'
      + '              child.kill()\n              return None\n'],
  ['supervisor reads a cancellation as a suite status instead of no status',
    '                      continue\n              return None\n',
    '                      continue\n              return 0\n'],
  // -- cancel during cleanup: cleanup completes, and reports on its own terms --
  ['supervisor cuts the cleanup join short on a cancellation instead of completing it',
    '                      trouble = stop(child, what)\n',
    '                      if CANCELLED:\n                          continue\n'
      + '                      trouble = stop(child, what)\n'],
  ['supervisor skips the owned cleanup altogether once a cancellation is recorded',
    '                  for child, what in ((suite, "acceptance suite"), (wm, "Openbox")):\n',
    '                  for child, what in (() if CANCELLED else ((suite, "acceptance suite"),\n'
      + '                                                            (wm, "Openbox"))):\n'],
  ['supervisor lets a cancellation hide a cleanup failure it already reported',
    '                  note("wm-cleanup (owned-processes=%d cleanup-errors=%d"\n',
    '                  if CANCELLED:\n                      return 143\n'
      + '                  note("wm-cleanup (owned-processes=%d cleanup-errors=%d"\n'],
  // -- repeated signals: the FIRST signal recorded fixes the status, and nothing moves it --
  ['supervisor lets a later signal move the cancellation exit status',
    '                  return 128 + CANCELLED[0]\n',
    '                  return 128 + CANCELLED[-1]\n'],
  ['supervisor reports a fixed cancellation status instead of the signal it recorded',
    '                  return 128 + CANCELLED[0]\n', '                  return 143\n'],
  ['supervisor reports a later signal than the one it acted on',
    '                  note("wm-cancelled (signal=%d)" % CANCELLED[0])\n',
    '                  note("wm-cancelled (signal=%d)" % CANCELLED[-1])\n'],
  ['supervisor reports a cancelled run as a pass',
    '              if CANCELLED:\n'
      + '                  note("wm-cancelled (signal=%d)" % CANCELLED[0])\n',
    '              if False:\n'
      + '                  note("wm-cancelled (signal=%d)" % CANCELLED[0])\n'],
  ['supervisor stops marking cleanup as already running',
    '                  CLEANING.append(True)\n', '                  pass\n'],
  ['supervisor lets repeated cancellation re-enter the handler',
    '              signal.signal(signal.SIGINT, signal.SIG_IGN)\n'
      + '              signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
      + '              CANCELLED.append(number)\n',
    '              CANCELLED.append(number)\n'],
  // -- suite status and cleanup errors stay separate, and both survive --
  ['supervisor reports a green suite whose cleanup failed as a pass',
    '              if cleanup_rc:\n', '              if False:\n'],
  ['supervisor drops the acceptance status instead of re-raising it',
    '                  return suite_rc if suite_rc > 0 else 128 - suite_rc\n',
    '                  return 0\n'],
  ['supervisor reports ownership on stdout where it can be mistaken for results',
    '              sys.stderr.write("browser-tls ci: %s\\n" % text)\n',
    '              sys.stdout.write("browser-tls ci: %s\\n" % text)\n'],
  // -- the suite stays owned and byte-unchanged --
  ['supervisor runs the suite outside its own ownership',
    '                      suite = subprocess.Popen(["npm", "run", "test:browser-tls"])\n'
      + '                      suite_rc = await_owned(suite)\n',
    '                      suite_rc = subprocess.call(["nohup", "npm", "run", "test:browser-tls"])\n'],
  ['supervisor replaces the acceptance suite',
    '["npm", "run", "test:browser-tls"]', '["echo", "green"]'],
  // -- the budget is not raised, and the install stays its own CI-only step --
  ['experiment inflates the caller budget to pay for the window manager',
    '        timeout-minutes: 10\n', '        timeout-minutes: 15\n'],
  ['CI-only window manager install step removed', ciOpenboxInstall, ''],
  ['window manager install pulls recommended packages',
    '          sudo apt-get install -y --no-install-recommends openbox x11-utils\n',
    '          sudo apt-get install -y openbox x11-utils\n'],
  ['window manager install stops proving the tools it added are present',
    '          command -v openbox\n          command -v xprop\n', ''],
  ['supervisor interpreter is no longer proved present',
    '          command -v python3\n', ''],

  // #1177 THE PRESERVED INITIAL-READ EVIDENCE. The measured refusal this corrects reported
  // only that the initial `_NET_SUPPORTING_WM_CHECK` state "came back unknown": the probe's
  // exit status, its property response and its diagnostic stderr were all discarded at the
  // point of reading, so a red job named the gap and carried nothing to act on. The record
  // is bounded, sanitized, emitted on every outcome and read by NOTHING, so each half of
  // that is its own negative - the evidence may not disappear again, and it may not start
  // relaxing the refusal it exists to explain.
  ['supervisor discards the initial probe stderr again',
    '                                        stderr=subprocess.PIPE,\n',
    '                                        stderr=subprocess.DEVNULL,\n'],
  ['supervisor stops asking the initial read to record why it was unknown',
    '              state, existing = supporting(["-root"], deadline, probe)\n',
    '              state, existing = supporting(["-root"], deadline)\n'],
  ['supervisor keeps the initial probe evidence out of the failed CI output',
    '                  note("wm-baseline-probe (%s)" % seen)\n',
    '                  pass\n'],
  ['supervisor drops the record every probe outcome funnels into',
    '              if evidence is None:\n'
      + '                  return\n',
    '              return\n'],
  ['supervisor records the initial read without the xprop exit status',
    '              record(evidence, name, "exit-%d" % done.returncode, done.stdout, done.stderr,\n'
      + '                     False)\n',
    '              record(evidence, name, "exit", done.stdout, done.stderr,\n'
      + '                     False)\n'],
  ['supervisor records the initial read only when xprop already succeeded',
    '              record(evidence, name, "exit-%d" % done.returncode, done.stdout, done.stderr,\n'
      + '                     False)\n'
      + '              if done.returncode != 0:\n',
    '              if done.returncode != 0:\n'],
  ['supervisor stops recording a probe that could not be invoked at all',
    '                  record(evidence, name, "not-invoked-deadline-passed", b"", b"", False)\n',
    '                  pass\n'],
  ['supervisor loses the spawn failure that stopped the initial read',
    '                  record(evidence, name, "not-invoked-errno-%s" % failure.errno,\n'
      + '                         b"", b"", False)\n',
    '                  pass\n'],
  ['supervisor stops recording the probe timeout as its own field',
    '                  record(evidence, name, "timed-out", expired.stdout, expired.stderr, True)\n',
    '                  record(evidence, name, "timed-out", expired.stdout, expired.stderr, False)\n'],
  ['supervisor throws away what a timed-out probe had already printed',
    '                  record(evidence, name, "timed-out", expired.stdout, expired.stderr, True)\n',
    '                  record(evidence, name, "timed-out", b"", b"", True)\n'],
  ['supervisor reports a truncated probe stream as a complete one',
    '              return (shown, len(data), len(data) > EVIDENCE_BYTES)\n',
    '              return (shown, len(data), False)\n'],
  ['supervisor stops reporting how much the probe actually printed',
    '              return (shown, len(data), len(data) > EVIDENCE_BYTES)\n',
    '              return (shown, len(shown), len(data) > EVIDENCE_BYTES)\n'],
  ['supervisor lets one probe record grow without bound',
    '              kept = data[:EVIDENCE_BYTES]\n',
    '              kept = data\n'],
  ['supervisor raises the per-stream evidence cap to an unbounded dump',
    '          EVIDENCE_BYTES = 200   # per-stream cap on what one probe record may carry\n',
    '          EVIDENCE_BYTES = 1000000   # per-stream cap\n'],
  ['supervisor records the diagnostic stream without redacting path-shaped tokens',
    '              if redact:\n'
      + '                  kept = PATHLIKE.sub(b"(path)", kept)\n',
    '              if False:\n'
      + '                  kept = PATHLIKE.sub(b"(path)", kept)\n'],
  ['supervisor lets a recorded stream forge a second log line',
    '              shown = "".join(chr(b) if 32 <= b < 127 and chr(b) not in \'<"\' else "<%02x>" % b\n'
      + '                              for b in kept)\n',
    '              shown = kept.decode("utf-8", "replace")\n'],

  // #1177 BYTE FIDELITY OF THAT RECORD. An earlier shape of this record decoded the capped
  // bytes with "replace" before rendering them, so every byte the display's own locale had
  // produced - \xff, \xfe, a lone UTF-8 continuation, the tail of a character the cap split -
  // arrived in the log as the same U+FFFD. The byte count stayed right, so the loss was
  // silent: a record whose entire purpose is naming why a read came back unknown could not
  // distinguish two different failures from each other. Rendering is per RAW byte for that
  // reason, and each control below pins one line that has to stay that way - no decode
  // before the rendering, no byte passed through unescaped because it happens to be
  // printable in some encoding, and the cap still taken on the bytes rather than after.
  ['supervisor decodes the probe bytes before rendering and collapses the distinct ones',
    '              shown = "".join(chr(b) if 32 <= b < 127 and chr(b) not in \'<"\' else "<%02x>" % b\n'
      + '                              for b in kept)\n',
    '              shown = "".join(c if 32 <= ord(c) < 127 and c not in \'<"\' else "<%02x>" % ord(c)\n'
      + '                              for c in kept.decode("utf-8", "replace"))\n'],
  ['supervisor emits a non-ASCII probe byte as itself instead of an exact escape',
    '              shown = "".join(chr(b) if 32 <= b < 127 and chr(b) not in \'<"\' else "<%02x>" % b\n',
    '              shown = "".join(chr(b) if 32 <= b < 256 and chr(b) not in \'<"\' else "<%02x>" % b\n'],
  ['supervisor caps the probe stream after decoding rather than on its raw bytes',
    '              kept = data[:EVIDENCE_BYTES]\n',
    '              kept = data.decode("utf-8", "replace")[:EVIDENCE_BYTES].encode("utf-8")\n'],
  ['supervisor path redaction stops matching the raw probe bytes',
    '          PATHLIKE = re.compile(b"/[^ ]*")\n',
    '          PATHLIKE = re.compile("/[^ ]*")\n'],
  ['supervisor redacts the exact property response the refusal has to explain',
    '              shown_out, out_bytes, out_cut = sanitize(out, False)\n',
    '              shown_out, out_bytes, out_cut = sanitize(out, True)\n'],
  ['supervisor bounds the classified stdout by the diagnostic evidence cap',
    '              text = done.stdout.decode("utf-8", "replace").strip()\n',
    '              text = done.stdout.decode("utf-8", "replace")[:EVIDENCE_BYTES].strip()\n'],
  ['supervisor lets the recorded evidence relax the fail-closed initial refusal',
    '              if state != "absent":\n',
    '              if state != "absent" and not probe:\n'],
  ['supervisor treats a recorded probe as the absent initial state it did not observe',
    '              if state != "absent":\n',
    '              if state != "absent" and not probe[0].startswith("property="):\n'],

  // #1177 THE TWO EXIT-ZERO ABSENCE SPELLINGS. The measured counterexample: release HEAD
  // 2fbe671, CI 36239796578, job 108398040073 exited 0 having printed exactly the 55 bytes
  // `_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\n` and nothing else. The reader
  // recognised only the anchored `not found.` form, so `supporting()` rejected an OBSERVED
  // absence as unknown and no Openbox and no browser were ever launched. Both spellings come
  // out of one function in the official X.Org source (xprop.c, `Show_Prop`): the atom-does-
  // not-exist branch after `Parse_Atom(prop, True)` == `XInternAtom(.., only_if_exists=True)`
  // returns None, and the property-not-on-this-window branch. Each negative below pins one
  // half of the correction: BOTH forms are recognised, and the widening the recognition may
  // not undergo - the property-name anchor, both end anchors, the exit-zero precondition and
  // the unknown fallthrough - is rejected BY NAME rather than only by the byte comparison.
  ['supervisor stops recognising the observed absent-atom spelling and refuses a real absence',
    '              if re.match("^" + name + r":\\s+no such atom on any window\\.$", text):\n'
      + '                  return ("absent", "")\n', ''],
  ['supervisor stops recognising the absent-property spelling it already handled',
    '              if re.match("^" + name + r":\\s+not found\\.$", text):\n'
      + '                  return ("absent", "")\n', ''],
  // Anchored and property-specific: a response ABOUT ANOTHER PROPERTY may not be read as
  // this property being absent, which is exactly what dropping the name anchor would do.
  ['supervisor reads an absent-atom answer about a foreign property as this one being absent',
    '              if re.match("^" + name + r":\\s+no such atom on any window\\.$", text):\n',
    '              if re.match("^[^:]+" + r":\\s+no such atom on any window\\.$", text):\n'],
  // Arbitrary text before the phrase is the specific over-broad shape rejected here: it turns
  // any output that merely CONTAINS the words into a verdict.
  ['supervisor widens the absent-atom form to an unanchored substring search',
    'r":\\s+no such atom on any window\\.$"', 'r".*no such atom on any window"'],
  // A truncated or extended response is malformed, and malformed stays unknown.
  ['supervisor drops the end anchor so an extended absent-atom response still reads as absence',
    'r":\\s+no such atom on any window\\.$"', 'r":\\s+no such atom on any window"'],
  // Both spellings are classified only AFTER the exit status was accepted, so a failing or
  // erroring xprop that happened to print the phrase can never become an absence.
  ['supervisor classifies the absence spellings without first requiring a zero xprop exit',
    '              if done.returncode != 0:\n                  return ("unknown", "")\n', ''],
  // Everything the two anchored forms did not match is still handed back for the caller to
  // reject as unknown; it may not fall through into absence.
  ['supervisor turns the unrecognised-shape fallthrough into absence',
    '              return ("ok", text)\n', '              return ("absent", "")\n'],
  // The shell diagnostic learns the same one spelling and no more. Written WITHOUT a wildcard
  // on purpose: a `"PROP:"*"phrase"` pattern would admit arbitrary text between the property
  // name and the phrase, which is wider than anything the source confirms.
  ['diagnostic stops recognising the observed absent-atom spelling',
    '                  "_NET_SUPPORTING_WM_CHECK:  no such atom on any window.") ewmh=absent ;;\n',
    ''],
  ['diagnostic widens the absent-atom case to admit arbitrary text around the phrase',
    '                  "_NET_SUPPORTING_WM_CHECK:  no such atom on any window.") ewmh=absent ;;\n',
    '                  *"no such atom on any window"*) ewmh=absent ;;\n'],
];
const publishDependencies = ['browser-tls', ...original.jobs.publish.needs, ...ids];
const publishNeeds = `    needs: [${publishDependencies.join(', ')}]\n`;
const releaseBrowserMutations = [
  ['missing guard browser dependency', '    needs: [browser-tls]\n', ''],
  ['extra guard dependency', '    needs: [browser-tls]\n', '    needs: [browser-tls, test]\n'],
  ...publishDependencies.map(id => [`missing publish ${id}`, publishNeeds, `    needs: [${publishDependencies.filter(value => value !== id).join(', ')}]\n`]),
  ['extra publish dependency', publishNeeds, `    needs: [${[...publishDependencies, 'unapproved'].join(', ')}]\n`],
  ['guard skip', '  guard:\n', '  guard:\n    if: false\n'],
  ['guard always', '  guard:\n', '  guard:\n    if: always()\n'],
  ['guard continue-on-error', '  guard:\n', '  guard:\n    continue-on-error: true\n'],
  ['publish skip', '  publish:\n', '  publish:\n    if: false\n'],
  ['policy trust input missing', '          RELEASE_SECURITY_POLICY_SHA256: UNREVIEWED\n', ''],
  ['policy trust input changed', '          RELEASE_SECURITY_POLICY_SHA256: UNREVIEWED\n', '          RELEASE_SECURITY_POLICY_SHA256: approved\n'],
  ['commit trust input missing', '          RELEASE_SECURITY_COMMIT: ${{ github.sha }}\n', ''],
  ['commit trust input changed', '          RELEASE_SECURITY_COMMIT: ${{ github.sha }}\n', '          RELEASE_SECURITY_COMMIT: main\n'],
  ['original release version input changed', '          RELEASE_VERSION: ${{ steps.identity.outputs.version }}\n', '          RELEASE_VERSION: arbitrary\n'],
  ['publish authentication changed', '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n', '          NODE_AUTH_TOKEN: arbitrary\n'],
];
const callerContracts = {
  CI: { addition: ciBrowserAddition, caller: ciHeadedCaller, run: ciDiagnosticRun },
  release: { addition: browserAddition, caller: headedCaller, run: xvfbLine },
};
for (const [workflowName, path] of [['CI', '.github/workflows/ci.yml'], ['release', '.github/workflows/release.yml']]) {
  const source = lf(readFileSync(join(root, path), 'utf8'));
  const browserMutations = browserMutationsFor(callerContracts[workflowName]);
  for (const [ending, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const encode = value => lf(value).replaceAll('\n', newline);
    const check = value => workflowName === 'CI'
      ? validateCIHistory(value, encode(readFileSync(join(root, fixtureRoot, 'ci.before-parity.yml'), 'utf8')))
      : validateReleaseHistory(parse(`${workflowName} ${ending} variant`, value));
    acceptance(`browser projection accepts ${workflowName} ${ending}`, 'browser-projection', () => check(encode(source)));
    const mutations = workflowName === 'CI' ? [
      ...browserMutations,
      ...ciDiagnosticMutations,
      ['unrelated comment byte changed', '# #894.', '# #894 changed.'],
      ['Windows debt threshold changed', "EXPECTED_WIN32_FAILURES: '33'", "EXPECTED_WIN32_FAILURES: '32'"],
    ] : [...browserMutations, ...releaseBrowserMutations];
    for (const [name, needle, replacement] of mutations) {
      acceptance(`browser projection rejects ${workflowName} ${ending}: ${name}`, 'browser-projection-mutant', () => {
        const changed = encode(replaceOnce(source, needle, replacement));
        assert.throws(() => check(changed), assert.AssertionError);
      });
    }
  }
}

after(() => {
  const afterHashes = snapshot();
  const counts = { tests: manifest.length, pass: manifest.filter(c => c.status === 'pass').length,
    fail: manifest.filter(c => c.status === 'fail').length, skip: 0 };
  writeFileSync(join(evidence, 'source-after.json'), JSON.stringify(afterHashes, null, 2));
  writeFileSync(join(evidence, 'case-manifest.json'), JSON.stringify({
    node: process.version, executable: process.execPath, admin, evidence, frozen,
    tools: { ruby, bash, utilities },
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))), persistenceFiles,
    callerRunnerSha256: sha(callerSource), callerStaleGuardSha256: sha(staleGuardSource),
    counts, cases: manifest, fixtures: cases, ciReplayFixtures, invocations,
    limits: ['Local fake-command control flow only; no actual Windows, GHA schema/scheduling or side-effect absence proof.',
      'Regular-CI Windows full-suite debt is excluded; native OS declaration remains unsupported.',
      'YAML fixtures are not product security clearance. Exact-source Snyk remains blocked by known tls652; no retry/upload.'],
  }, null, 2));
  assert.deepEqual(afterHashes, before, 'all hashed product, baseline and CI sources unchanged');
});
