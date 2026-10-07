// Local gate-control acceptance only. Runner copies execute test-owned sentinels;
// application Node/npm entrypoints are never executed.
// Node 20; Ruby/Psych, Bash, Git and cat/grep/tail/awk on PATH. No configuration required.
// Optional absolute overrides: WINDOWS_GATE_RUBY, WINDOWS_GATE_BASH, WINDOWS_GATE_GIT,
// WINDOWS_GATE_UTILS (cat/grep/tail/awk directory), WINDOWS_GATE_EVIDENCE.
// See fixtures/windows-gates/README.md for prerequisites, evidence and provenance.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync,
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
// W-D3: the Windows jobs are named for what they measure. `ids` are the two windows-latest jobs, `declared`
// the ubuntu declaration job; `successor` maps each retired id to the job that now measures it.
const ids = ['windows-suite', 'windows-installed'];
const declared = 'windows-declared-supported';
const successor = { 'windows-declared-unsupported': declared, 'windows-persistence': 'windows-suite', 'windows-refuses': 'windows-installed' };
// The historical fixtures still carry the retired ids; they are compared, never regenerated.
const oldIds = ['windows-persistence', 'windows-refuses'];
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
      # #1177 — the private playwright-core copy the acceptance below loads, CI only. The script
      # re-verifies the lock, playwright-core 1.58.2, Chromium r1208 / 145.0.7632.6 and the exact
      # installed tree, then writes ONE copy into RUNNER_TEMP whose only difference is crPage.js's
      # own-frame focus emulation enabled:false - the arm-B library probe run 36323626280 measured.
      # package.json, package-lock.json and node_modules are not written, nothing is downloaded, and
      # any pin mismatch, a Playwright upgrade included, fails this step by name.
      - name: Prepare the verified private playwright-core copy
        run: node scripts/ci/acceptance-playwright-core.mjs prepare
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
          # #1177 the one verified private copy; the acceptance refuses in CI without it.
          BROWSER_TLS_PLAYWRIGHT_CORE: \${{ runner.temp }}/acceptance-playwright-core/node_modules/playwright-core
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
          BROWSER_TLS_PLAYWRIGHT_CORE: \${{ runner.temp }}/acceptance-playwright-core/node_modules/playwright-core
          BROWSER_TLS_RECEIPT: \${{ runner.temp }}/browser-tls-receipt.json
          CONSOLE_UI_ARTIFACTS: \${{ runner.temp }}/console-ui-artifacts
        run: npm run test:browser-tls -- --validate-receipt
      # #1177 — again after the run: package.json, package-lock.json, the installed playwright-core
      # and the private copy must all still equal what the prepare step recorded and pinned.
      - name: Originals and private playwright-core copy unchanged after the run
        run: node scripts/ci/acceptance-playwright-core.mjs verify
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
// The plain headed caller the CI contract below is derived from (#1177: release.yml no longer
// carries it - it runs the CI job itself): wrapper, owner-only authority cookie, a display that
// never listens on TCP, and nothing else.
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
// #1177: release.yml runs this same CI contract byte for byte, so a release gate runs exactly
// what CI measured; the plain caller above is only the base the CI contract is derived from.
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
        #   * Ownership is PROVEN, not inferred from a property being present. The proof is the
        #     server's OWN answer, not the window manager's word for it: the compiled XRes probe
        #     asks the X server which CLIENT owns the supporting window and which pid that client
        #     registered, inside one \`XGrabServer\` bracket, and the answer must name the exact
        #     process this supervisor's own \`Popen\` handle started. That REPLACES the
        #     client-asserted \`_NET_WM_PID\` window property this readiness proof used to require —
        #     a property Openbox 3.6.1-10 never sets, and which was only ever the window
        #     manager's own claim about itself. It is a REPLACEMENT, never a downgrade: the
        #     exact-owned-process requirement is strictly stronger, and every other link in the
        #     chain (private display, observed absent-to-present transition, self-consistent
        #     supporting window, window name) is still required and still substitutes for nothing.
        #     See the supervisor's own readiness comment.
        #   * The probe's answer is an ATOMIC SNAPSHOT and is never represented as continuous
        #     ownership. It is bracketed by a \`poll()\` on the owner handle immediately before the
        #     probe is spawned and immediately after it is reaped, so the instant the server
        #     answered lies inside an interval over which that pid provably denotes one live
        #     process; an exit mid-bracket discards the comparison rather than reinterpreting it.
        #   * Every way the proof can fail to land is a REFUSAL, never a pass and never a
        #     downgrade: a missing or non-executable probe, a server without the X-Resource
        #     capability or with one older than 1.2, a non-zero or unrecognised exit status,
        #     output this supervisor's strict whole-line parse rejects, a foreign or ambiguous
        #     owning client, a supporting window that is absent or is not the one this supervisor
        #     itself saw, a dead child, or a bound that expired.
        #   * The probe is invoked in its real measuring mode ONLY — \`--mode wm --owner-pid <the
        #     handle's own pid>\`, a real server grab, and nothing else. Its source also carries
        #     reduced and instrumented modes for the isolated prototype's oracles
        #     (\`--mode xid\`/\`bogus\`/\`helper\`, \`--no-grab\`, \`--grab-delay-ms\`); NONE of them is
        #     ever passed here, and a record that reports \`mode=\`/\`grab=\`/\`instrumented=\`
        #     anything other than \`wm\`/\`held\`/\`no\` is refused rather than read as a measurement.
        #   * The suite is byte-unchanged: the same \`npm run test:browser-tls\`, no fixture,
        #     product or sandbox change, no Playwright change of its own (#1177: the one verified
        #     private playwright-core copy is the prepare step's), no forced or synthesized
        #     visibility. It runs
        #     as an owned child so a cancellation stops what this caller started; its own
        #     descendants are NOT signalled, because reaching them would mean assuming a process
        #     group, which is outside what this was authorized to do.
        # This may well stay red, and a verified-ownership run that is still red would be a REAL
        # result. It resolves exactly ONE environmental hypothesis - whether a real EWMH window
        # manager on this display changes what the lifecycle stage observes. It is NOT a claim
        # that an absent WM caused the failure, it closes no task-table gate, and it does not
        # touch the live competing explanation: the harness never minimizes the window (#1177
        # removed that experiment), so \`lw-hidden-wait\` polls a window in state \`normal\` whether
        # or not a window manager is present.
`;
const ciDiagnosticRun = `          # The supervisor is written out here, under that same \`umask 077\`, so the file is
          # owner-only by construction. It is a CI-only file in RUNNER_TEMP, run by the runner
          # image's own \`python3\`: nothing is installed to produce it, it never enters the
          # package, and release.yml runs this same step.
          export WM_SUPERVISOR="$RUNNER_TEMP/wm-owned-supervisor.py"
          cat >"$WM_SUPERVISOR" <<"PY"
          # #1177 owned-process supervisor, CI only and deliberately not a product module: it
          # starts ONE window manager on the display this xvfb-run already owns, proves that
          # exact process owns it, runs the unchanged acceptance suite, and stops only what it
          # started. Standard library only, and one synchronous owner from start to finish.
          #
          # HOW OWNERSHIP IS PROVED, AND WHAT CHANGED
          #   The exact-owned-process requirement is unchanged and is not weakened anywhere below.
          #   What changed is WHO ANSWERS IT. This supervisor used to require the \`_NET_WM_PID\`
          #   window property on the supporting window to equal this child's pid. That property is
          #   the window manager's own CLAIM about itself — an ordinary client-settable property,
          #   with no server-side binding to the connection that set it — and Openbox 3.6.1-10
          #   never sets it at all, so the proof could not be satisfied on this image.
          #
          #   It is now answered by the X server instead, through the X-Resource extension: the
          #   compiled \`xres-owner\` probe asks the server which CLIENT owns the supporting window
          #   and which pid that client registered, inside one \`XGrabServer\` bracket, and the pid
          #   must be exactly the process this supervisor's own \`Popen\` handle started. That is
          #   strictly STRONGER than the property it replaces, and it is a REPLACEMENT, not a
          #   downgrade: there is no path below on which a missing capability, an unreadable
          #   answer or an inexact match is accepted, and every other link in the chain — the
          #   private display, the observed absent-to-present transition, the self-consistent
          #   supporting window, the window name — is still required and still substitutes for
          #   nothing.
          #
          #   The probe's answer is an ATOMIC SNAPSHOT of one instant, not a lease: it is read
          #   inside a \`poll()\` bracket on the owner handle taken immediately before the probe is
          #   spawned and immediately after it is reaped, and an exit inside that bracket DISCARDS
          #   the comparison. Nothing below claims ownership persisted after the snapshot.
          import os
          import re
          import signal
          import subprocess
          import sys
          import time

          READY_SECONDS = 30.0   # whole readiness phase, the baseline read included
          PROBE_SECONDS = 5.0    # per-xprop bound, clamped to what is left of READY_SECONDS
          # Bound on ONE \`xres-owner\` invocation, also clamped to what is left of READY_SECONDS.
          # Larger than the sum of the probe's own two internal 5s bounds - one over the
          # capability gate, one over the grab bracket - so contention with another client's
          # server grab normally surfaces as the probe's legible \`grab-unavailable\` record rather
          # than as this bound's opaque timeout. An expiry here is a REFUSAL, never absence.
          # The number is 15 and not larger for a second reason: a cancellation is acted on
          # between iterations of the readiness loop, so this is also the longest this loop can
          # go without noticing one, and 15s is exactly the window the three 5s xprop reads
          # already imposed. So the loop's responsiveness to INT/TERM is unchanged, and
          # READY_SECONDS still ends the whole phase regardless.
          OWNER_SECONDS = 15.0
          TERM_SECONDS = 10.0    # bounded join after SIGTERM
          KILL_SECONDS = 5.0     # bounded join after SIGKILL
          POLL_SECONDS = 0.5     # cancellation poll at each wait taken before cleanup
          EVIDENCE_BYTES = 200   # per-stream cap on what one probe record may carry
          # The probe's own widest renderable record is ~473 bytes, so the xprop cap above would
          # truncate exactly the line a failure needs read. This larger cap is used for that ONE
          # stream and nothing else; it bounds a record whose shape is fixed by the probe, and it
          # is diagnostic only — no verdict below reads a rendered stream.
          OWNER_EVIDENCE_BYTES = 768
          SUPPORTING = "_NET_SUPPORTING_WM_CHECK"
          YESNO = {True: "yes", False: "no"}
          # Path-shaped tokens are redacted out of DIAGNOSTIC streams only. This is a BOUND on
          # what a record may carry and not a parser: it matches the RAW capped bytes, before
          # the printable rendering below, and redacting more than a path is always safe here
          # while redacting less is not, so it deliberately runs to the next space rather than
          # trying to be exact. It is a BYTES pattern because nothing here ever decodes.
          PATHLIKE = re.compile(b"/[^ ]*")
          # The probe's fixed single-record protocol, in the field order it writes, reproduced
          # from the record \`xres-owner.c\` renders and NOT invented here. One strict whole-line
          # pattern: anything that does not match the whole of it is UNPARSABLE, which is
          # \`owner-unreadable\`, and it is never partially salvaged. \`refusal\` is matched as an
          # explicit CLOSED alternation of the nine tokens the probe emits rather than as a
          # character class, so a tenth token would make the record unparsable — refusing — rather
          # than be carried through as an unknown string.
          RECORD = re.compile(
              r"^xres-owner \\(verdict=(?P<verdict>[a-z0-9-]+) mode=(?P<mode>[a-z]+)"
              r" grab=(?P<grab>held|absent|unavailable|-) instrumented=(?P<instrumented>yes|no)"
              r" delay-ms=(?P<delay_ms>[0-9]+) window=(?P<window>0x[0-9a-f]+|-)"
              r" probed-xid=(?P<probed>0x[0-9a-f]+|-) existence=(?P<existence>ok|badwindow|-)"
              r" step6=(?P<step6>ok|badwindow|-) xres-status=(?P<xres_status>success|failed|-)"
              r" num-ids=(?P<num_ids>[0-9]+|-) length=(?P<length>[0-9]+|-)"
              r" pid=(?P<pid>[0-9]+|-) owner-pid=(?P<owner_pid>[0-9]+|-)"
              r" server-version=(?P<version>[0-9]+\\.[0-9]+|-)"
              r" x-error=(?P<x_error>[0-9]+/[0-9]+|-)"
              r" ret-client=(?P<ret_client>0x[0-9a-f]+|-) ret-mask=(?P<ret_mask>0x[0-9a-f]+|-)"
              r" refusal=(?P<refusal>xres-status|num-ids-zero|num-ids-many|ids-null"
              r"|client-mismatch|mask-mismatch|length-range|value-null|pid-invalid|-)\\)$")
          # The specific gap each refusal reports, so a failure names what was missing rather
          # than only that something was. The first block is this supervisor's own; the second is
          # the probe's closed verdict set, passed through verbatim so a refusal names the X
          # server's answer rather than being re-spelled here.
          GAP = {
              "exited": "the owned Openbox exited before any ownership evidence appeared",
              "timeout": "no ownership evidence appeared inside the readiness deadline",
              "cancelled": "the run was cancelled before ownership could be proved",
              "not-self-consistent": "the supporting window did not point back at itself, so"
                                     " that registration is stale",
              "unnamed": "the supporting window published no readable _NET_WM_NAME",
              "foreign-wm": "the supporting window belongs to a different window manager",
              "probe-missing": "the compiled XRes ownership probe named by XRES_OWNER_BIN was"
                               " missing or not executable, so the server could not be asked who"
                               " owns the supporting window",
              "probe-artificial": "the probe reported a reduced or instrumented run, which is a"
                                  " control and is never read as a measurement",
              "w-changed": "the probe resolved a different supporting window than this supervisor"
                           " had just observed, so the two readings name different instants",
              "owner-unreadable": "the probe produced no record this supervisor can read - a"
                                  " non-zero or unrecognised exit status, an expired bound, output"
                                  " its strict whole-line parse rejects, or a record that says"
                                  " owned while a field it must agree with does not",
              "xres-unavailable": "this X server does not offer the X-Resource extension, so"
                                  " exact-owned-process ownership cannot be asked of it at all",
              "xres-too-old": "this X server's X-Resource version is older than the 1.2 that"
                              " reports client pids",
              "grab-unavailable": "the probe could not complete its bracket inside its own bound,"
                                  " which is contention with another client's server grab",
              "w-unregistered": "the probe found no supporting window registered on the root"
                                " inside its grab",
              "w-absent": "the supporting window did not exist when the probe checked it",
              "w-not-self": "the supporting window did not point back at itself inside the"
                            " probe's grab, so that registration is stale",
              "w-foreign-wm": "the supporting window published no readable _NET_WM_NAME naming"
                              " Openbox inside the probe's grab",
              "owner-refused": "an X-Resource request the ownership proof depends on did not"
                               " succeed",
              "owner-unknown": "the server named no owning pid for the supporting window, which"
                               " is not an absence that may be read as a pass",
              "owner-ambiguous": "the server did not name exactly one live client as the owner of"
                                 " the supporting window",
              "owner-malformed": "the owning-client reply was not in a shape the probe may read",
              "owner-foreign": "the server named a pid other than this child as the owner of the"
                               " supporting window",
          }
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


          def sanitize(raw, redact, cap=EVIDENCE_BYTES):
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
              kept = data[:cap]
              if redact:
                  kept = PATHLIKE.sub(b"(path)", kept)
              shown = "".join(chr(b) if 32 <= b < 127 and chr(b) not in '<"' else "<%02x>" % b
                              for b in kept)
              return (shown, len(data), len(data) > cap)


          def record(evidence, name, status, out, err, timed_out, cap=EVIDENCE_BYTES,
                     label="property"):
              """Append exactly one bounded probe record, or nothing at all when the caller did
              not ask for one. The classified status, the truncation of each stream and the
              timeout are each their OWN field: none of them can be lost inside another, and
              none of them is ever folded into an absence. Nothing else about the run is
              recorded - no environment, no argument vector, no process listing.
              \`cap\` is the per-stream byte bound and defaults to the xprop one, so every existing
              caller is unchanged; the ownership probe passes its own larger bound because its
              record line is longer than an xprop response and truncating it would hide exactly
              what a refusal needs read. It is still a BOUND, and still diagnostic only.
              \`label\` names what \`name\` identifies and defaults to \`property\`, which is what every
              xprop caller records. The ownership probe passes \`probe\` instead, because what it
              invoked is a subprocess and not a window property - calling it one would be exactly
              the kind of stale _NET_WM_PID-shaped claim this readiness proof no longer makes."""
              if evidence is None:
                  return
              shown_out, out_bytes, out_cut = sanitize(out, False, cap)
              shown_err, err_bytes, err_cut = sanitize(err, True, cap)
              evidence.append('%s=%s status=%s timed-out=%s stdout-bytes=%d'
                              ' stdout-truncated=%s stdout="%s" stderr-bytes=%d'
                              ' stderr-truncated=%s stderr="%s"'
                              % (label, name, status, YESNO[timed_out], out_bytes, YESNO[out_cut],
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


          def owner_binary():
              """The compiled XRes ownership probe, or None when there is not one to invoke.

              This is a REQUIRED capability, checked before anything is started. An unset, empty
              or non-executable XRES_OWNER_BIN REFUSES in main(); it is never a licence to fall
              back to the client-asserted _NET_WM_PID window property this replaces, and there is
              no second, weaker proof anywhere below to fall back TO."""
              path = os.environ.get("XRES_OWNER_BIN", "")
              if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):
                  return None
              return path


          def artificial(fields):
              """True when this record did not come from a real, full measurement.

              The probe's source also supports reduced and instrumented runs for the isolated
              prototype's oracles - other modes, an artificial in-grab delay, and a no-grab
              negative control - and it DISCLOSES which it did in every record. This supervisor
              passes none of those options, so a record reporting anything but
              \`mode=wm grab=held instrumented=no\` is refused rather than read as a measurement of
              this display: a control must never be able to stand in for the real thing, even if
              some future caller or a substituted binary were to enable one."""
              return (fields["instrumented"] != "no" or fields["mode"] != "wm"
                      or fields["grab"] != "held")


          def xres_owned(binary, wm, window, deadline, evidence=None):
              """Ask the X SERVER, through the X-Resource extension, whether \`window\` is a live
              window whose owning CLIENT is exactly this child, and return \`owned\` or a named
              refusal. This is the link that replaces the _NET_WM_PID window property.

              One bounded invocation of the probe in its real measuring mode and nothing else:
              \`--mode wm --owner-pid <this handle's own pid>\`, a real server grab, no reduced mode
              and no instrumentation. The pid comes from the \`Popen\` handle this supervisor
              created, which is the only authenticated identity here - nothing is parsed out of a
              log or a process list, and nothing foreign is ever named.

              EVERY outcome that is not an exact match REFUSES, and none of them is absence:
              a bound that expired, a probe that could not be run, an exit status outside the
              probe's own {0 owned, 2 determinate refusal}, output the strict whole-line RECORD
              pattern rejects, an exit status and a printed verdict that disagree, any of the
              probe's own refusal verdicts, a reduced or instrumented run, a supporting window
              other than the one this supervisor just observed, and a record that claims \`owned\`
              while a field it must agree with does not.

              ATOMICITY. The probe's answer is a snapshot taken inside its own XGrabServer
              bracket; it is not a lease, and nothing here represents it as continuous ownership.
              It is bracketed instead: \`poll()\` immediately before the spawn and again immediately
              after the reap, with no cached reading, so the instant the server answered lies
              inside an interval over which \`wm.pid\` provably denotes one live process. \`poll()\`
              itself reaps, so a non-None at t2 means the child exited AND was just reaped - the
              verdict becomes \`exited\` and the pid comparison is DISCARDED rather than reported.

              The per-call bound is clamped to what is left of the shared readiness deadline, so
              this cannot outlive it. \`evidence\` receives exactly one bounded, sanitized record of
              what the invocation did, which is DIAGNOSTIC ONLY: no verdict returned here reads
              it, and no branch below is relaxed by what it carried."""
              left = deadline - time.monotonic()
              if left <= 0:
                  record(evidence, "xres-owner", "not-invoked-deadline-passed", b"", b"", False,
                         OWNER_EVIDENCE_BYTES, "probe")
                  return "timeout"
              if wm.poll() is not None:                                       # t0
                  return "exited"
              try:
                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", str(wm.pid)],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE,
                                        timeout=min(OWNER_SECONDS, left))
              except subprocess.TimeoutExpired as expired:
                  # Whatever it had already printed is kept, and the timeout is its own field
                  # rather than an empty reading that would look like a probe printing nothing.
                  record(evidence, "xres-owner", "timed-out", expired.stdout, expired.stderr,
                         True, OWNER_EVIDENCE_BYTES, "probe")
                  return "owner-unreadable"
              except OSError as failure:
                  # Only the numeric errno: the message can carry a path and nothing needs one.
                  record(evidence, "xres-owner", "not-invoked-errno-%s" % failure.errno,
                         b"", b"", False, OWNER_EVIDENCE_BYTES, "probe")
                  return "owner-unreadable"
              # Recorded BEFORE any classification, so an exit status this does not accept and a
              # record this cannot parse stay distinguishable afterwards.
              record(evidence, "xres-owner", "exit-%d" % done.returncode, done.stdout,
                     done.stderr, False, OWNER_EVIDENCE_BYTES, "probe")
              if wm.poll() is not None:                                       # t2
                  return "exited"
              # The probe's own contract: 0 iff \`owned\`, 2 for a determinate refusal it printed,
              # anything else is no usable record. Both halves are required to agree.
              if done.returncode not in (0, 2):
                  return "owner-unreadable"
              lines = [line for line in done.stdout.decode("utf-8", "replace").splitlines()
                       if line]
              if len(lines) != 1:
                  return "owner-unreadable"
              found = RECORD.match(lines[0])
              if not found:
                  return "owner-unreadable"
              fields = found.groupdict()
              if (done.returncode == 0) != (fields["verdict"] == "owned"):
                  return "owner-unreadable"
              if fields["verdict"] != "owned":
                  # The probe's closed verdict set, passed through verbatim so the refusal names
                  # the server's answer - a missing or too-old capability, contention, an absent,
                  # stale or foreign supporting window, an ambiguous or foreign owning client -
                  # rather than being flattened into one opaque token here.
                  return fields["verdict"]
              if artificial(fields):
                  return "probe-artificial"
              # The supporting window identity. This supervisor resolved W with its own xprop
              # chain and the probe re-resolved it from the root inside its grab; if the two
              # differ they name different instants, and the un-grabbed interval between them is
              # refused rather than pretended away.
              if fields["window"] == "-" or int(fields["window"], 16) != window:
                  return "w-changed"
              # Internal consistency of a record that claims \`owned\`. Each of these is ENTAILED by
              # \`owned\` in the probe, so a disagreement means the record is not one this
              # supervisor can read - not that a weaker reading of it should be accepted.
              if (fields["probed"] != fields["window"] or fields["existence"] != "ok"
                      or fields["step6"] != "ok" or fields["xres_status"] != "success"
                      or fields["num_ids"] != "1" or fields["length"] == "-"
                      or fields["refusal"] != "-" or fields["version"] == "-"):
                  return "owner-unreadable"
              # The exact owned live pid, re-compared here against the handle this supervisor
              # started: the probe's own comparison is never the only check. Both the pid the
              # server reported and the pid the probe was asked about must be this child.
              if fields["pid"] == "-" or int(fields["pid"]) != wm.pid:
                  return "owner-unreadable"
              if fields["owner_pid"] == "-" or int(fields["owner_pid"]) != wm.pid:
                  return "owner-unreadable"
              return "owned"


          def readiness(binary, wm, deadline):
              """Bounded proof that THIS child owns THIS display, or a named refusal. All of
              these are required, in order: the root points at a supporting window W; W points
              back at itself, which is the EWMH staleness test; W is named Openbox; the X SERVER
              names this exact child as the client that owns W; and the child is alive on both
              sides of that answer.

              The last two links come from the \`xres-owner\` probe and REPLACE the _NET_WM_PID
              window property this used to read. The requirement is unchanged in strength and is
              not downgraded anywhere: the private display, the observed absent-to-present
              transition, the self-consistency test and the window name are each still necessary
              and not one of them is accepted in place of the server's own answer. What changed is
              that the answer no longer comes from a property the window manager set about itself.

              The probe re-derives the whole W chain inside its own grab; neither chain substitutes
              for the other, and the two W readings must agree. The trailing liveness check this
              function used to make is now the probe bracket's t2 poll, which is strictly tighter:
              it is taken immediately after the probe is reaped rather than after a further
              round trip."""
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
                  # The ownership answer, and the one thing that can return \`owned\`. Its record is
                  # emitted on EVERY outcome and before this function returns, so what the probe
                  # actually did is on the log whether this refuses or goes on; it goes to stderr,
                  # which survives the exit 1 below where the success-only uploads do not; and it
                  # is read by NOTHING - no branch consults it, so it can neither relax the
                  # refusal, shorten the proof, nor stand in for an answer that was not given.
                  proof = []
                  verdict = xres_owned(binary, wm, window, deadline, proof)
                  for seen in proof:
                      note("wm-ownership-probe (%s)" % seen)
                  return verdict


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
              # The ownership proof is a REQUIRED capability and is checked FIRST, before the
              # display is even read and before anything is started, so a missing probe costs
              # nothing and cannot be discovered halfway through owning a window manager. There is
              # deliberately no fallback: the _NET_WM_PID property this replaces is not consulted
              # anywhere below, so an absent probe means ownership cannot be proved at all.
              binary = owner_binary()
              if binary is None:
                  problem("%s. Nothing was started and the acceptance suite was NOT run."
                          % GAP["probe-missing"])
                  return 1
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
                  ready = readiness(binary, wm, deadline)
                  # \`ownership\` names WHAT was established, not merely that something was: only
                  # the server's own exact-owned-client answer earns the positive token, and every
                  # other readiness outcome reads as unproven. There is no third value.
                  note("wm-owned (started=openbox readiness=%s ownership=%s waited=%.1fs)"
                       % (ready,
                          "xres-exact-owned-client" if ready == "owned" else "unproven",
                          time.monotonic() - started))
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
                          " %s. The X server's own exact-owned-client answer is REQUIRED and is"
                          " not downgraded - the private display, the absent-to-present"
                          " transition, the self-consistency test and the window name do not"
                          " replace it, and the _NET_WM_PID property it replaced is weaker and is"
                          " not consulted as a fallback - and no other window manager is selected"
                          " instead. The acceptance suite was NOT run and nothing was measured."
                          % (ready, GAP.get(ready, "no ownership evidence")))
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
const ciOpenboxInstall = `      # #1177 — the ONE bounded window-manager experiment, CI only and only in this job. The display
      # the acceptance run owns has never had a window manager on it: \`Browser.setWindowBounds
      # {windowState:'minimized'}\` reads back \`normal\`, and both owned tabs stay \`visible\` while
      # focus moves. That is evidence, NOT proof that an absent WM is the cause, so this installs
      # a real EWMH window manager and measures the SAME suite against it rather than asserting
      # anything. Openbox is the smallest EWMH-compliant choice in the image's archive; x11-utils
      # supplies the \`xprop\` the supervisor's own baseline chain below reads, which the
      # observation-only probe treats as optional and this experiment requires; and \`libxres-dev\`
      # plus \`libx11-dev\` are the build dependency the XRes ownership probe needs — the SAME two
      # official packages, and the same \`-lXRes -lX11\` link line, that the isolated prototype lane
      # compiled and exercised on this exact runner image. They are installed in this separate step
      # so the install cost lands outside the acceptance step's unchanged 10-minute budget and
      # outside the real browser user process entirely, and \`apt-get update\` already ran in the
      # runner preflight above. \`python3\` and \`cc\` are NOT installed: the supervisor below is one
      # file of the standard library and the probe is one C file, so the interpreter and the
      # compiler the runner image already ships are proved present here instead of anything being
      # added to get them. Nothing is installed on a host, nothing enters package.json or
      # package-lock.json, NO runtime npm or native dependency is created and no user of this
      # package is ever asked for a compiler — the probe is CI-only infrastructure that is built
      # into, and dies with, RUNNER_TEMP. No new privilege is taken beyond the apt-get
      # the runner preflight above already uses, and release.yml runs this same job byte for byte,
      # so the release gate runs exactly what CI measured.
      - name: Install the CI-only window manager and XRes build deps for the owned display experiment
        run: |
          set -euo pipefail
          sudo apt-get install -y --no-install-recommends \\
            openbox x11-utils libxres-dev libx11-dev
          command -v openbox
          command -v xprop
          command -v python3
          command -v cc

`;
// #1177 — the CI-only XRes ownership probe compile step, restated independently for
// the same reason as the install and the caller: it is held to the bounds it was
// approved under, not to what the workflow happens to carry. It compiles the frozen
// prototype-validated C with the prototype's exact command line, measures the package
// and header provenance instead of asserting it, and starts no process on any display.
const ciXresCompile = `      # #1177 — the ownership proof the supervisor below actually uses, compiled here rather than
      # shipped. \`scripts/ci/xres-owner.c\` is the byte-identical source the ISOLATED prototype lane
      # validated on this same \`ubuntu-22.04\` image (12 of 12 oracles green, including the full
      # \`mode=wm grab=held instrumented=no\` positive against a real Openbox), and it is compiled
      # with the SAME command line that lane used: \`cc -O2 -Wall -Wextra ... -lXRes -lX11\`, the
      # official libraries only, no hand-written X11 protocol and no private libXres internals.
      # \`-Werror\` is deliberately NOT used, because a warning from a system header would then block
      # this lane for something that is not a defect in the probe.
      #
      # ubuntu-22.04 is not incidental. The probe's public-API contract is version-exact for jammy
      # (\`libxres1\` 2:1.2.1-1, \`XRes.h\` at tag libXres-1.2.1), which is why the installed package
      # versions and the installed header's hash go in the log next to the binary's: the provenance
      # is MEASURED here rather than asserted by this comment. If this image is ever retired the
      # correct move is to re-pin deliberately and re-establish version-exactness, not to bump the
      # label and keep the claim.
      #
      # This step installs nothing, takes no root, touches no package manifest and starts no
      # process on any display. The binary is written under \`umask 077\` into a directory this step
      # creates inside RUNNER_TEMP, so it is owner-only by construction and is destroyed with the
      # ephemeral runner.
      - name: Compile the CI-only XRes ownership probe
        run: |
          set -euo pipefail
          umask 077
          mkdir -p "$RUNNER_TEMP/xres"
          dpkg-query -W -f='\${Package} \${Version}\\n' libxres1 libxres-dev libx11-dev
          header=/usr/include/X11/extensions/XRes.h
          test -f "$header"
          sha256sum "$header"
          cc -O2 -Wall -Wextra -o "$RUNNER_TEMP/xres/xres-owner" \\
            scripts/ci/xres-owner.c -lXRes -lX11
          test -x "$RUNNER_TEMP/xres/xres-owner"
          sha256sum scripts/ci/xres-owner.c "$RUNNER_TEMP/xres/xres-owner"
`;
// The acceptance step's one extra env var: the probe the compile step produced. A
// REQUIRED capability the supervisor refuses without, never a fallback, so it is its
// own literal and its own negative rather than part of the caller body.
const ciXresEnv = `          # The probe the step above compiled. A REQUIRED capability: the supervisor refuses when
          # this is unset or not executable, and never falls back to a weaker proof.
          XRES_OWNER_BIN: \${{ runner.temp }}/xres/xres-owner
`;
// The `# Headed Chromium ...` rationale's first line. It is the unique bytes that follow the
// acceptance step's own `env:` block, so it anchors both the CI-only env addition below and
// the Console-artifacts negatives further down, which would otherwise have to restate it.
const headedRationaleAnchor = '        # Headed Chromium on a private virtual display owned by this non-root ephemeral\n';
// Built by substitution so the CI contract can differ from the plain base contract in exactly
// three places — the headed caller, the two CI-only steps inserted before it (the window
// manager/XRes build-dependency install and the probe compile), and the one extra env var
// the acceptance step needs to find the compiled probe — and in no other byte. `replaceOnce`
// asserts each target is unique in the source and that the replacement changes bytes, so
// none of them can land twice or land somewhere else. The env addition is anchored on the
// rationale line that follows the env block, because the `CONSOLE_UI_ARTIFACTS` key it goes
// after is byte-identical on two steps of this job.
const ciBrowserAddition = replaceOnce(
  replaceOnce(
    replaceOnce(browserAddition, approvedHeadedCaller, ciHeadedCaller),
    browserCallerStep, `${ciOpenboxInstall}${ciXresCompile}${browserCallerStep}`),
  headedRationaleAnchor, `${ciXresEnv}${headedRationaleAnchor}`);
const approvedCIBrowser = parse('approved-ci-browser-contract', `jobs:\n${ciBrowserAddition}`).jobs['browser-tls'];
// #1167 independent approved Windows contract (the browserAddition pattern; never derived from a workflow under
// test): CI's exact bytes from the first Windows comment to EOF, and the one header sentence that changed with it.
// release.yml must carry the same three jobs, parsed, plus `needs: guard`.
const approvedWindowsRegion = `  # Windows is supported in 0.2.2, with two documented limitations that refuse instead of
  # running: confined worker spawn (SANDBOX_PLATFORM_UNSUPPORTED, exit 78) and native request
  # capture (init exits 2). The three jobs below are what a green check claims for Windows.
  # release.yml carries all three byte for byte, adding only \`needs: guard\`, so a green PR
  # predicts the Windows half of a release the way the \`test\` job above predicts the POSIX half.
  # They are separate jobs rather than windows-latest in the \`test\` matrix because four of that
  # job's seven steps are POSIX shell gates, and per-OS \`if:\` guards would end the #900 parity.
  #
  # The declaration: package.json os[] and the lock file's root entry must both include win32,
  # compared as one serialised string. W0 below repeats the check on the OS it is about.
  windows-declared-supported:
    name: Windows is declared supported
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: package.json and the lock file must declare Windows in
        shell: bash
        run: |
          set -euo pipefail
          OS="$(node -p "JSON.stringify([require('./package.json').os, require('./package-lock.json').packages[''].os])")"
          [ "$OS" = '[["darwin","linux","win32"],["darwin","linux","win32"]]' ] || { echo "::error::package.json and package-lock.json declare os \${OS}; both must be [\\"darwin\\",\\"linux\\",\\"win32\\"] so a plain npm install admits Windows."; exit 1; }
          echo "os declaration is \${OS}"

  # #901 (W1), now the whole suite: every test on windows-latest, held to zero failures and zero
  # skips. There is no known-failure allowance and no --force; Windows is declared in os[], so a
  # plain \`npm ci\` must install. A POSIX-only behaviour is split by platform inside its test, with
  # each OS asserting its own branch, never skipped.
  #
  # The checkout keeps LF bytes (core.autocrlf false): tests/packaging/init-platform.test.mjs runs
  # the real init, whose scaffold step runs bin/install-instructions.sh under Git Bash, and a CRLF
  # checkout of that script cannot run.
  windows-suite:
    name: Windows W1 — full suite, zero failures and zero skips
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      - name: Check out with LF endings, as the published tarball has them
        shell: bash
        run: git config --global core.autocrlf false
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Install dependencies (plain npm ci; Windows is declared in os[])
        shell: bash
        run: npm ci

      - name: Build
        shell: bash
        run: npm run build

      # THE #901 GATE, unchanged bytes (the corrected #1171 reader): the persistence layer keeps
      # its own hard green, so a failure there is named before the full-suite step runs.
      - name: Persistence suite must be fully green on win32
        shell: bash
        run: |
          set -uo pipefail
          set +e
          node --test dist/tests/session/persistence/*.test.js > "\${RUNNER_TEMP}/persistence.log" 2>&1
          RC=$?
          set -e
          cat "\${RUNNER_TEMP}/persistence.log"
          read_count() {
            awk -v key="$1" '
              { sub(/\\r$/, "") }
              $0 ~ ("^# " key "([[:space:]]|$)") {
                records++
                if ($0 !~ ("^# " key " [0-9]+$")) malformed = 1
                else count = $3
              }
              END { if (records == 1 && !malformed) print count }
            ' "\${RUNNER_TEMP}/persistence.log"
          }
          PASS="$(read_count pass)"; FAIL="$(read_count fail)"; SKIP="$(read_count skipped)"
          # Refuse to assert on numbers we could not read — an empty string compares equal
          # to nothing and would let this pass vacuously.
          [ -n "\${PASS}" ] && [ -n "\${FAIL}" ] && [ -n "\${SKIP}" ] \\
            || { echo "::error::could not parse the TAP summary; refusing to report a vacuous pass."; exit 1; }
          echo "win32 persistence: pass=\${PASS} fail=\${FAIL} skipped=\${SKIP}"
          [ "\${FAIL}" = "0" ] || { echo "::error::\${FAIL} persistence test(s) failed on win32. This is the surface #901 delivers; it does not get a known-failure allowance."; exit 1; }
          [ "\${SKIP}" = "0" ] || { echo "::error::\${SKIP} persistence test(s) skipped on win32 — a skip here is a win32 behaviour that went unmeasured."; exit 1; }
          [ "\${PASS}" -gt 20 ] || { echo "::error::only \${PASS} persistence tests ran; the file glob is probably not matching."; exit 1; }
          [ "\${RC}" = "0" ] || { echo "::error::the runner exited \${RC} despite a clean summary."; exit 1; }

      # Everything else, through the same runner \`npm test\` uses. The summary is read with the same
      # strict reader as the persistence step: each of tests, pass, fail and skipped exactly once as
      # \`# key N\`, CR stripped, anything else refused. Every violation is reported before the step
      # fails, so one run names all of them. The >200 floor is the U28 proof that
      # scripts/run-tests.mjs:31 enumerates compiled tests correctly on Windows.
      - name: Full suite must be fully green on win32
        shell: bash
        run: |
          set -uo pipefail
          set +e
          node scripts/run-tests.mjs > "\${RUNNER_TEMP}/full.log" 2>&1
          RC=$?
          set -e
          cat "\${RUNNER_TEMP}/full.log"
          read_count() {
            awk -v key="$1" '
              { sub(/\\r$/, "") }
              $0 ~ ("^# " key "([[:space:]]|$)") {
                records++
                if ($0 !~ ("^# " key " [0-9]+$")) malformed = 1
                else count = $3
              }
              END { if (records == 1 && !malformed) print count }
            ' "\${RUNNER_TEMP}/full.log"
          }
          TESTS="$(read_count tests)"
          PASS="$(read_count pass)"; FAIL="$(read_count fail)"; SKIP="$(read_count skipped)"
          # Refuse to assert on numbers we could not read — an empty string compares equal
          # to nothing and would let this pass vacuously.
          [ -n "\${TESTS}" ] && [ -n "\${PASS}" ] && [ -n "\${FAIL}" ] && [ -n "\${SKIP}" ] \\
            || { echo "::error::could not parse the TAP summary; refusing to report a vacuous pass."; exit 1; }
          echo "win32 full suite: tests=\${TESTS} pass=\${PASS} fail=\${FAIL} skipped=\${SKIP} runner exit=\${RC}"
          VIOLATIONS=0
          # A TRUE \`-gt\` is the success condition: \`[\` exits 2 on a count it cannot compare, and
          # that error falls to the violation branch exactly as a false comparison does.
          if [ "\${TESTS}" -gt 200 ]; then
            :
          else
            echo "::error::only \${TESTS} tests were enumerated. scripts/run-tests.mjs:31 normalises Windows separators for node --test; a low count means that enumeration is broken (U28)."
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
          if [ "\${SKIP}" != "0" ]; then
            echo "::error::\${SKIP} test(s) skipped on win32. A skip is a Windows behaviour that went unmeasured; split the test by platform instead."
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
          if [ "\${FAIL}" != "0" ]; then
            echo "--- failures this run ---"
            grep '^not ok' "\${RUNNER_TEMP}/full.log" || true
            echo "::error::\${FAIL} test(s) failed on win32. Windows is supported; there is no known-failure allowance."
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
          if [ "\${RC}" != "0" ]; then
            echo "::error::the runner exited \${RC}; a cancelled test or a harness failure is not a pass."
            VIOLATIONS=$((VIOLATIONS + 1))
          fi
          [ "\${VIOLATIONS}" = "0" ] || { echo "::error::\${VIOLATIONS} win32 gate violation(s) reported above; every applicable diagnostic ran before this failure."; exit 1; }
          echo "win32 full suite is fully green"

  # #900 (W0), now the installed package: what a Windows user gets from the published tarball.
  # It packs on this runner with LF bytes (W-D4), installs the tarball into a temporary global
  # prefix with no --force, runs the bin shim from cmd.exe, PowerShell and Git Bash, inits a
  # workspace in a fresh home through the .cmd shim, runs workspace shell entry points under Git
  # Bash, and asserts both documented limitations as clean refusals.
  windows-installed:
    name: Windows W0 — the installed package works
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - name: Check out with LF endings, as the published tarball has them
        shell: bash
        run: git config --global core.autocrlf false
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: package.json and the lock file must declare Windows in
        shell: bash
        run: |
          set -euo pipefail
          OS="$(node -p "JSON.stringify([require('./package.json').os, require('./package-lock.json').packages[''].os])")"
          [ "$OS" = '[["darwin","linux","win32"],["darwin","linux","win32"]]' ] || { echo "::error::package.json and package-lock.json declare os \${OS}; both must be [\\"darwin\\",\\"linux\\",\\"win32\\"] so a plain npm install admits Windows."; exit 1; }
          echo "os declaration is \${OS}"

      # U23, inverted. Measured 2026-08-15 (run 31890807632): npm enforces the root manifest's own
      # os[], so with win32 declared out \`npm ci\` died with EBADPLATFORM. Windows is declared in
      # now, so a plain install is the assertion, and EBADPLATFORM anywhere in its log fails it.
      - name: U23 — npm ci must succeed on win32 without --force
        shell: bash
        run: |
          set -uo pipefail
          set +e
          npm ci > "\${RUNNER_TEMP}/npm-ci.log" 2>&1
          RC=$?
          set -e
          echo "npm ci exit=\${RC}"
          tail -n 40 "\${RUNNER_TEMP}/npm-ci.log"
          [ "$RC" = "0" ] || { echo "::error::npm ci failed on win32 with exit \${RC}. Windows is declared in os[]; a plain, unforced install must succeed."; exit 1; }
          if grep -q 'EBADPLATFORM' "\${RUNNER_TEMP}/npm-ci.log"; then echo "::error::npm ci exited 0 on win32 but logged EBADPLATFORM; the os[] declaration is not what npm read."; exit 1; fi
          echo "plain npm ci installed on win32"

      # prepack builds. The scan reads the pack's own file list, so it covers exactly the shell
      # files the tarball ships; one CR in any of them would ship a script bash cannot run.
      - name: Pack the tarball; shipped shell files must be LF
        shell: bash
        run: |
          set -euo pipefail
          npm pack --json > "\${RUNNER_TEMP}/pack.json"
          node -e '
            const fs = require("node:fs");
            const pack = JSON.parse(fs.readFileSync(process.env.RUNNER_TEMP + "/pack.json", "utf8"))[0];
            const shell = pack.files.map(file => file.path.split("\\\\").join("/"))
              .filter(path => /^(bin\\/.*\\.sh|git-hooks\\/pre-push|\\.claude\\/hooks\\/[^\\/]*\\.sh|tooling\\/dispatch-prelude\\/[^\\/]*\\.sh)$/.test(path));
            const required = ["bin/install-instructions.sh", "git-hooks/pre-push"].filter(path => !shell.includes(path));
            const carriageReturn = shell.filter(path => fs.readFileSync(path).includes(13));
            console.log(\`shipped shell files: \${shell.length}; with CR: \${carriageReturn.length}\`);
            for (const path of required) console.log(\`::error::\${path} is not in the pack file list; the scan would be vacuous.\`);
            for (const path of carriageReturn) console.log(\`::error::\${path} has CR line endings; bash cannot run it from the tarball (W-D4).\`);
            if (required.length || carriageReturn.length) process.exit(1);
            fs.writeFileSync(process.env.RUNNER_TEMP + "/tarball", pack.filename);
          '

      - name: Install the tarball into a temporary global prefix without --force
        shell: bash
        run: |
          set -uo pipefail
          TARBALL="$(cat "\${RUNNER_TEMP}/tarball")"
          PREFIX="\${RUNNER_TEMP}/w0-prefix"
          set +e
          npm install -g --prefix "\${PREFIX}" "./\${TARBALL}" > "\${RUNNER_TEMP}/npm-install.log" 2>&1
          RC=$?
          set -e
          echo "npm install -g exit=\${RC}"
          tail -n 40 "\${RUNNER_TEMP}/npm-install.log"
          [ "$RC" = "0" ] || { echo "::error::installing \${TARBALL} into a global prefix failed on win32 with exit \${RC}."; exit 1; }
          if grep -q 'EBADPLATFORM' "\${RUNNER_TEMP}/npm-install.log"; then echo "::error::the tarball install logged EBADPLATFORM; the published os[] must admit win32."; exit 1; fi
          for SHIM in aigentry-orchestrator aigentry-orchestrator.cmd aigentry-orchestrator.ps1; do
            [ -f "\${PREFIX}/\${SHIM}" ] || { echo "::error::npm wrote no \${SHIM} shim into the global prefix."; exit 1; }
          done
          echo "\${TARBALL} installed unforced; the sh, cmd and PowerShell shims exist"

      # U21 — npm generates the Windows shims from the \`#!/usr/bin/env node\` shebang of a .mjs bin.
      # --version returns before any platform or dependency check, so this measures the shims.
      - name: U21 — the bin shim runs from cmd.exe, PowerShell and Git Bash
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $prefix = Join-Path $env:RUNNER_TEMP 'w0-prefix'
          $expected = (Get-Content -Raw package.json | ConvertFrom-Json).version
          # Git for Windows' own bash, found next to git.exe; never WSL's System32\\bash.exe.
          $bash = Join-Path (Split-Path -Parent (Split-Path -Parent (Get-Command git.exe).Source)) 'bin\\bash.exe'
          $shim = (Join-Path $prefix 'aigentry-orchestrator').Replace('\\', '/')
          function Assert-Version([string] $label, $output) {
            $code = $LASTEXITCODE
            $text = (($output | Out-String) -replace "\`r", '').Trim()
            if ($code -ne 0 -or $text -ne $expected) {
              Write-Output "::error::the $label shim printed '$text' with exit $code; expected '$expected'."
              exit 1
            }
            Write-Output "$label shim reports $text"
          }
          Assert-Version 'cmd.exe' (& (Join-Path $prefix 'aigentry-orchestrator.cmd') --version)
          Assert-Version 'PowerShell' (& (Join-Path $prefix 'aigentry-orchestrator.ps1') --version)
          Assert-Version 'Git Bash' (& $bash -c "'$shim' --version")

      # The native user path: PowerShell, the .cmd shim, a fresh profile and AIGENTRY_HOME unset.
      # installed-init-check compares the tree with the installed package's own manifest.
      - name: init succeeds in a temporary home and produces the expected tree
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $prefix = Join-Path $env:RUNNER_TEMP 'w0-prefix'
          $package = Join-Path $prefix 'node_modules\\@dmsdc-ai\\aigentry-orchestrator'
          $cli = Join-Path $prefix 'aigentry-orchestrator.cmd'
          $userHome = Join-Path $env:RUNNER_TEMP 'w0-home'
          $ws = Join-Path $env:RUNNER_TEMP 'w0-ws'
          New-Item -ItemType Directory -Path $userHome | Out-Null
          $env:USERPROFILE = $userHome
          $env:HOME = $userHome
          Remove-Item Env:AIGENTRY_HOME -ErrorAction SilentlyContinue
          function Assert-Exit([string] $label, [int] $want) {
            if ($LASTEXITCODE -ne $want) {
              Write-Output "::error::$label exited $LASTEXITCODE on win32; expected $want."
              exit 1
            }
            Write-Output "$label exited $want, as required"
          }
          & $cli init --yes --workspace $ws
          Assert-Exit 'init' 0
          node tests/packaging/installed-init-check.mjs --package $package --workspace $ws --home (Join-Path $userHome '.aigentry')
          Assert-Exit 'installed-init-check' 0
          $queue = Join-Path $ws 'state\\task-queue.json'
          $before = (Get-FileHash -Algorithm SHA256 -LiteralPath $queue).Hash
          & $cli init --yes --workspace $ws
          Assert-Exit 'a second plain init' 4
          & $cli init --upgrade --yes --workspace $ws
          Assert-Exit 'init --upgrade' 0
          $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $queue).Hash
          if ($after -ne $before) {
            Write-Output "::error::init --upgrade changed state/task-queue.json; state/ must stay untouched."
            exit 1
          }
          Write-Output "state/task-queue.json is byte-identical after --upgrade"

      # C10: the workspace has no dist/, so a bin/ shim resolves the installed package through the
      # npm sh shim on PATH (a file on Windows, not a symlink) and must reach the compiled CLI.
      - name: Workspace shell entry points run under Git Bash
        shell: bash
        run: |
          set -euo pipefail
          T="$(cygpath -u "\${RUNNER_TEMP}")"
          WS="\${T}/w0-ws"
          export HOME="\${T}/w0-home"
          export USERPROFILE="$(cygpath -w "\${HOME}")"
          export PATH="\${T}/w0-prefix:\${PATH}"
          OUT="$(bash "\${WS}/bin/tq-status.sh")"
          printf '%s\\n' "\${OUT}"
          case "\${OUT}" in
            "=== Active Focus ==="*) echo "bin/tq-status.sh printed the status overview" ;;
            *) echo "::error::bin/tq-status.sh did not print its status overview under Git Bash."; exit 1 ;;
          esac
          OUT="$(bash "\${WS}/bin/dispatch-tracker.sh" --help)"
          case "\${OUT}" in
            "# dispatch-tracker.sh "*"Orchestrator-side dispatch health-check"*) echo "bin/dispatch-tracker.sh reached the compiled tracker CLI of the installed package" ;;
            *) printf '%s\\n' "\${OUT}"; echo "::error::bin/dispatch-tracker.sh --help did not print the tracker usage."; exit 1 ;;
          esac

      # Limitation 1 (P6). A dispatch reaches the confinement decision only with a dispatchable
      # task in the workspace queue, a task-bound worker scope and a claude executable on PATH for
      # the spawn decision, so the probe supplies exactly those; the stand-in claude never runs,
      # because the refusal comes first. Nothing may be staged: the sessions directory is unchanged
      # and the --cwd is never created.
      - name: Confined dispatch is refused cleanly with exit 78
        shell: bash
        run: |
          set -euo pipefail
          T="$(cygpath -u "\${RUNNER_TEMP}")"
          WS="\${T}/w0-ws"
          export HOME="\${T}/w0-home"
          export USERPROFILE="$(cygpath -w "\${HOME}")"
          mkdir -p "\${T}/w0-fake-bin"
          printf '#!/bin/sh\\nexit 99\\n' > "\${T}/w0-fake-bin/claude"
          export PATH="\${T}/w0-prefix:\${T}/w0-fake-bin:\${PATH}"
          node -e 'const fs = require("node:fs"); const queue = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); queue.tasks.push({ id: 1, status: "pending", track: "w0", desc: "W0 confined-dispatch refusal probe" }); fs.writeFileSync(process.argv[1], JSON.stringify(queue, null, 2) + "\\n");' "$(cygpath -w "\${WS}/state/task-queue.json")"
          printf '{"version":1,"task":"1","sid":"w0-probe","domains":[],"read":[],"write":[]}\\n' > "\${T}/w0-scope.json"
          export AIGENTRY_WORKER_SCOPE="$(cygpath -w "\${T}/w0-scope.json")"
          printf 'W0 confined-dispatch refusal probe\\n' > "\${T}/w0-ref.md"
          SESSIONS="\${HOME}/.aigentry/sessions"
          BEFORE="$(ls -A "\${SESSIONS}" 2>/dev/null || true)"
          set +e
          bash "\${WS}/bin/dispatch.sh" --spawn-and-dispatch --track w0 --name probe --cwd "$(cygpath -w "\${T}/target")" \\
            --cli claude --role coder --task 1 --ref "$(cygpath -w "\${T}/w0-ref.md")" > "\${T}/dispatch.out" 2> "\${T}/dispatch.err"
          RC=$?
          set -e
          cat "\${T}/dispatch.out" "\${T}/dispatch.err"
          [ "\${RC}" = "78" ] || { echo "::error::dispatch.sh --spawn-and-dispatch exited \${RC} on win32; the confined spawn must refuse with exit 78."; exit 1; }
          grep -q 'SANDBOX_PLATFORM_UNSUPPORTED' "\${T}/dispatch.err" || { echo "::error::exit 78 without SANDBOX_PLATFORM_UNSUPPORTED on stderr."; exit 1; }
          AFTER="$(ls -A "\${SESSIONS}" 2>/dev/null || true)"
          [ "\${BEFORE}" = "\${AFTER}" ] || { echo "::error::the refused dispatch changed \${SESSIONS}."; exit 1; }
          [ ! -e "\${T}/target" ] || { echo "::error::the refused dispatch created its --cwd."; exit 1; }
          echo "confined dispatch refused with exit 78 and SANDBOX_PLATFORM_UNSUPPORTED; nothing was staged"

      # Limitation 2 (W-D2 B). init refuses the native capture options before it reads or writes
      # anything, so the workspace and the home are byte-identical afterwards.
      - name: Native capture refuses cleanly on win32
        shell: bash
        run: |
          set -euo pipefail
          T="$(cygpath -u "\${RUNNER_TEMP}")"
          WS="\${T}/w0-ws"
          export HOME="\${T}/w0-home"
          export USERPROFILE="$(cygpath -w "\${HOME}")"
          export PATH="\${T}/w0-prefix:\${PATH}"
          mkdir -p "\${T}/w0-capture" "\${T}/w0-preservation"
          snapshot() { find "\${WS}" "\${HOME}" -type d -print -o -type f -exec sha256sum {} + | sort; }
          BEFORE="$(snapshot)"
          set +e
          OUT="$(aigentry-orchestrator init --yes --workspace "$(cygpath -w "\${WS}")" --capture-root "$(cygpath -w "\${T}/w0-capture")" \\
            --preservation-root "$(cygpath -w "\${T}/w0-preservation")" 2>&1)"
          RC=$?
          set -e
          printf '%s\\n' "\${OUT}"
          [ "\${RC}" = "2" ] || { echo "::error::init with native capture options exited \${RC} on win32; it must refuse with exit 2."; exit 1; }
          case "\${OUT}" in
            *"is not available on native Windows in 0.2.2. Nothing was written."*) echo "native capture refused with exit 2 and the documented message" ;;
            *) echo "::error::init exited 2 without the documented native-capture refusal."; exit 1 ;;
          esac
          [ "$(snapshot)" = "\${BEFORE}" ] || { echo "::error::the refused native capture changed the workspace or the home."; exit 1; }
`;
const ciHeaderBefore = `# What this still does NOT measure, stated so a green check is not read as more than it is:
# the live-integration guards above, and anything Windows beyond the refusal asserted in
# the windows-refuses job below.
`;
const ciHeaderAfter = `# What this still does NOT measure, stated so a green check is not read as more than it is:
# the live-integration guards above. Windows is measured by the three jobs at the end of this
# file: it is supported except confined worker spawn and native request capture, and those two
# limitations are asserted as clean refusals, not skipped.
`;
// #1171 — the one approved change to the `test` job: both workflows carry these exact Dispatch guard
// suite bytes, restated here as an independent literal and never derived from either workflow. It
// replaces the step each historical fixture carried (release: cap 4; CI: cap 8) and nothing else.
const dispatchGuardName = 'Dispatch guard suite';
const dispatchGuardHead = `      - name: ${dispatchGuardName}\n        run: bash tests/dispatch/run-all.sh\n`;
const releaseDispatchGuardBefore = `${dispatchGuardHead}        timeout-minutes: 4\n`;
const ciDispatchGuardBefore = `${dispatchGuardHead}        # 4 was inside the runner's own variance, not above it. Measured on
        # macos-latest for the SAME commit: 2m44s vs 4m11s — 87s of spread — against a
        # main baseline of 3m07s, so the headroom was 53s < variance and the cap fired
        # on a suite that had already printed \`guards: 118 passed: 118 failed: 0\`
        # (one manual re-run needed). A timeout that trips on a PASSING suite teaches
        # people to re-run red CI, which is the opposite of what it is for. 8 leaves
        # ~5m of headroom and still catches a real hang.
        timeout-minutes: 8
`;
const dispatchGuardAfter = `${dispatchGuardHead}        # The cap must sit above the runner's variance, not inside it. A cap of 4 once fired
        # on a suite that had already printed \`guards: 118 passed: 118 failed: 0\`
        # (macos-latest, same commit: 2m44s vs 4m11s). The suite has grown since: at bb30eb3
        # it took 6m07s and 6m13s on macos-latest and 3m12s to 3m58s on ubuntu-latest, while
        # release.yml still carried 4, so the first v0.2.2 tag run timed out on a suite that
        # was passing. A timeout that trips on a PASSING suite teaches people to re-run red
        # CI, which is the opposite of what it is for. 12 is about twice the slower runner's
        # measured time and still catches a real hang. release.yml carries the same lines.
        timeout-minutes: 12
`;
// The step that follows it in both workflows, so no byte can be appended to the approved step unseen.
const dispatchGuardNext = '      - name: Ship-set agreement against the real tarball\n';
const parseDispatchGuard = (label, bytes) => named(parse(label, `jobs:\n  test:\n    steps:\n${bytes}`).jobs.test, dispatchGuardName);
const dispatchGuardSteps = {
  release: parseDispatchGuard('historical-release-dispatch-guard', releaseDispatchGuardBefore),
  ci: parseDispatchGuard('historical-ci-dispatch-guard', ciDispatchGuardBefore),
  approved: parseDispatchGuard('approved-dispatch-guard', dispatchGuardAfter),
};
for (const historical of [dispatchGuardSteps.release, dispatchGuardSteps.ci]) {
  assert.deepEqual({ ...historical, 'timeout-minutes': 12 }, dispatchGuardSteps.approved, 'parsed, only the Dispatch guard suite cap changes');
}
function withApprovedDispatchGuard(job, historical) {
  const copy = structuredClone(job);
  const step = named(copy, dispatchGuardName);
  assert.deepEqual(step, historical, 'historical Dispatch guard suite step');
  copy.steps[copy.steps.indexOf(step)] = structuredClone(dispatchGuardSteps.approved);
  return copy;
}
function assertDispatchGuardBytes(source, label) {
  assert.equal(lf(source).split(`${dispatchGuardAfter}${dispatchGuardNext}`).length, 2,
    `${label}: exactly the approved Dispatch guard suite step bytes`);
}
// #1196 — the one approved change to the `publish` job: the publish step gains `id: publish`, the
// PUBLISH_FAILED step follows it, and the registry read-back waits for npm's asynchronous processing
// (one read, then one every 15 s for 12 minutes) and names the registry's last answer. Restated here
// as an independent literal and never derived from either workflow. It replaces the publish and
// read-back steps both historical fixtures carry (6 x 10 s) and nothing else.
const publishStepName = 'Publish to npm';
const publishReadbackBefore = `      - name: Publish to npm
        if: steps.registry.outputs.exists != 'true'
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: npm publish "\${{ steps.pack.outputs.tarball }}" --access public

      # The verification that matters. A local build agreeing with itself proves nothing about
      # what users download. This reads the shasum back from the registry and compares it to
      # the tarball we packed. It runs on the fresh-publish path AND the already-published
      # path, so a green run always states the same true thing: npm serves these bytes.
      - name: The registry must serve the bytes we packed
        run: |
          set -euo pipefail
          LOCAL="\${{ steps.pack.outputs.shasum }}"
          REMOTE=""
          for attempt in 1 2 3 4 5 6; do
            REMOTE="$(npm view --prefer-online "\${PACKAGE}@\${VERSION}" dist.shasum 2>/dev/null || true)"
            [ -n "$REMOTE" ] && break
            echo "registry has not surfaced \${VERSION} yet (attempt \${attempt}/6); waiting 10s"
            sleep 10
          done
          if [ -z "$REMOTE" ]; then
            echo "::error::\${PACKAGE}@\${VERSION} is still not readable from the registry after publishing. The publish is NOT confirmed."
            exit 1
          fi
          if [ "$LOCAL" != "$REMOTE" ]; then
            echo "::error::npm serves \${PACKAGE}@\${VERSION} with sha1 \${REMOTE}, but this tag packs to \${LOCAL}. The registry's bytes are not this tag's bytes. npm versions are immutable — republish under a new version rather than assuming this is cosmetic."
            exit 1
          fi
          echo "registry sha1 \${REMOTE} matches the packed tarball"
`;
const publishReadbackAfter = `      # #1196: \`id\` so the step below can name PUBLISH_FAILED. Skipped is not failure, so on
      # the already-published path every step below still runs; do not add an \`if:\` to them.
      - name: Publish to npm
        id: publish
        if: steps.registry.outputs.exists != 'true'
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: npm publish "\${{ steps.pack.outputs.tarball }}" --access public

      # #1196, modelled on aigentry-telepty #1127. A red run has two causes that demand opposite
      # responses, and the badge alone cannot tell them apart. This step speaks for exactly one
      # of them: npm REJECTED the publish, so nothing was shipped.
      - name: Name the outcome when the publish itself failed
        if: failure() && steps.publish.outcome == 'failure'
        run: |
          set -euo pipefail
          {
            echo "### Registry proof — \\\`\${PACKAGE}@\${VERSION}\\\`"
            echo
            echo "**PUBLISH_FAILED** — \\\`npm publish\\\` was rejected, so \${VERSION} never reached the registry. Nothing was shipped; the publish step's own error says why. Fixing that cause and re-running is safe: there is no published version to collide with."
          } >> "$GITHUB_STEP_SUMMARY"
          echo "PUBLISH_FAILED: npm publish was rejected; \${PACKAGE}@\${VERSION} was not shipped."

      # The verification that matters. A local build agreeing with itself proves nothing about
      # what users download. This reads the shasum back from the registry and compares it to
      # the tarball we packed. It runs on the fresh-publish path AND the already-published
      # path, so a green run always states the same true thing: npm serves these bytes.
      #
      # #1196 — WHY THE BUDGET IS 12 MINUTES. The 0.2.2 publish SUCCEEDED, npm replied "being
      # processed and may take a few minutes", and this step's 6 x 10 s = 60 s ran out. The
      # version became readable about 4 minutes after the publish, so a finished release
      # reported failure and needed a manual re-run of this job. The gate is right; its budget
      # was shorter than npm's own asynchronous processing. So: one read now, then one every
      # 15 s for 12 minutes (49 reads), each read's answer printed, and on exhaustion the last
      # answer named — a 404 (npm has not surfaced the version yet) is not the same failure as
      # a registry that could not be read at all.
      - name: The registry must serve the bytes we packed
        run: |
          set -euo pipefail
          LOCAL="\${{ steps.pack.outputs.shasum }}"
          ATTEMPTS=49
          INTERVAL=15
          REMOTE=""
          ANSWER="no answer"
          for attempt in $(seq 1 "$ATTEMPTS"); do
            set +e
            REMOTE="$(npm view --prefer-online "\${PACKAGE}@\${VERSION}" dist.shasum 2>"\${RUNNER_TEMP}/readback.err")"
            RC=$?
            set -e
            [ "$RC" -eq 0 ] && [ -n "$REMOTE" ] && break
            REMOTE=""
            if grep -q 'E404' "\${RUNNER_TEMP}/readback.err"; then
              ANSWER="404 (npm has not surfaced \${VERSION} yet)"
            else
              DETAIL="$(grep -m 1 . "\${RUNNER_TEMP}/readback.err" || true)"
              ANSWER="not a 404 (npm view exited \${RC}: \${DETAIL:-no shasum and no error output})"
            fi
            if [ "$attempt" -lt "$ATTEMPTS" ]; then
              echo "read \${attempt}/\${ATTEMPTS}: registry answered \${ANSWER}; waiting \${INTERVAL}s"
              sleep "$INTERVAL"
            else
              echo "read \${attempt}/\${ATTEMPTS}: registry answered \${ANSWER}"
            fi
          done
          if [ -z "$REMOTE" ]; then
            {
              echo "### Registry proof — \\\`\${PACKAGE}@\${VERSION}\\\`"
              echo
              echo "**PUBLISHED_NOT_YET_READABLE** — npm did not reject the publish, but after \${ATTEMPTS} reads over $(( (ATTEMPTS - 1) * INTERVAL / 60 )) minutes the registry's last answer was \${ANSWER}. The publish is NOT confirmed, and this red run does NOT mean nothing shipped."
              echo
              echo "Remedy: once npm serves \${VERSION}, re-run this job. That run finds the version already present, skips the publish, verifies the bytes, and creates the GitHub Release. NOT the remedy: publishing again, or retagging — npm versions are immutable."
            } >> "$GITHUB_STEP_SUMMARY"
            echo "::error::PUBLISHED_NOT_YET_READABLE: \${PACKAGE}@\${VERSION} is still not readable from the registry after \${ATTEMPTS} reads over $(( (ATTEMPTS - 1) * INTERVAL / 60 )) minutes; the last answer was \${ANSWER}. The publish is NOT confirmed. Do NOT re-publish and do NOT retag; re-run this job once npm serves \${VERSION}."
            exit 1
          fi
          echo "read \${attempt}/\${ATTEMPTS}: registry serves sha1 \${REMOTE}"
          if [ "$LOCAL" != "$REMOTE" ]; then
            echo "::error::npm serves \${PACKAGE}@\${VERSION} with sha1 \${REMOTE}, but this tag packs to \${LOCAL}. The registry's bytes are not this tag's bytes. npm versions are immutable — republish under a new version rather than assuming this is cosmetic."
            exit 1
          fi
          echo "registry sha1 \${REMOTE} matches the packed tarball"
`;
// The bytes on either side of it in release.yml, so nothing can be prepended or appended unseen.
const publishReadbackPrevious = '            exit 1\n          fi\n\n';
const publishReadbackNext = '\n      # Second, independent proof: not the metadata npm reports, but the artifact a user\n';
const parsePublishSteps = (label, bytes) => parse(label, `jobs:\n  publish:\n    steps:\n${bytes}`).jobs.publish.steps;
const publishReadbackSteps = {
  historical: parsePublishSteps('historical-publish-readback', publishReadbackBefore),
  approved: parsePublishSteps('approved-publish-readback', publishReadbackAfter),
};
{
  const [historicalPublish, historicalReadback] = publishReadbackSteps.historical;
  const [approvedPublish, outcome, approvedReadback] = publishReadbackSteps.approved;
  assert.equal(publishReadbackSteps.historical.length, 2, 'historical publish and read-back steps');
  assert.equal(publishReadbackSteps.approved.length, 3, 'approved publish, outcome and read-back steps');
  assert.deepEqual(approvedPublish, { ...historicalPublish, id: 'publish' }, 'parsed, the publish step only gains its id');
  assert.deepEqual(outcome, { name: 'Name the outcome when the publish itself failed', if: "failure() && steps.publish.outcome == 'failure'",
    run: outcome.run }, 'the outcome step runs only when the publish step failed');
  assert.deepEqual({ ...approvedReadback, run: historicalReadback.run }, historicalReadback, 'parsed, the read-back changes only its script');
  // No loosening: the approved budget itself is held to the #1196 floor.
  const attempts = Number(/^ATTEMPTS=(\d+)$/m.exec(approvedReadback.run)?.[1]);
  const interval = Number(/^INTERVAL=(\d+)$/m.exec(approvedReadback.run)?.[1]);
  assert.ok(interval >= 15 && interval <= 20 && (attempts - 1) * interval >= 600, 'read-back polls every 15-20 s for at least 10 minutes');
}
function withApprovedPublishReadback(job) {
  const copy = structuredClone(job);
  const start = copy.steps.indexOf(named(copy, publishStepName));
  assert.deepEqual(copy.steps.slice(start, start + 2), publishReadbackSteps.historical, 'historical publish and read-back steps');
  copy.steps.splice(start, 2, ...structuredClone(publishReadbackSteps.approved));
  return copy;
}
function assertPublishReadbackBytes(source, label) {
  assert.equal(lf(source).split(`${publishReadbackPrevious}${publishReadbackAfter}${publishReadbackNext}`).length, 2,
    `${label}: exactly the approved publish and registry read-back bytes`);
}
const approvedWindows = parse('approved-windows-contract', `jobs:\n${approvedWindowsRegion}`).jobs;
assert.deepEqual(Object.keys(approvedWindows), [declared, ...ids], 'approved Windows contract names exactly the three successor jobs');
function withoutBrowser(workflow, release) {
  // #1177: both workflows carry the one CI contract, release included.
  assert.deepEqual(workflow.jobs['browser-tls'], approvedCIBrowser,
    'complete approved browser/TLS job, ordered steps and no bypasses');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:browser-tls'], 'node tests/hitl/browser-tls.acceptance.mjs', 'actual browser caller');
  assert.equal(pkg.devDependencies.playwright, '1.58.2', 'locked browser dependency');
  if (release) {
    assert.deepEqual(workflow.jobs.guard.needs, ['browser-tls'], 'guard requires browser success');
    assert.deepEqual(workflow.jobs.publish.needs, ['browser-tls', 'guard', 'test', declared, ...ids], 'browser, gate and Windows successor publish dependencies');
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
// #1167 — the replayed step bodies. `fullSuite` replaced the CI-only debt ratchet: zero failures, zero skips,
// no allowance. `ciDebtBaseline` is the frozen historical debt body, kept only so the masking it produced
// can still be replayed. Every body is Bash-syntax-checked by the loop below.
const persistenceStep = 'Persistence suite must be fully green on win32';
const fullSuiteStep = 'Full suite must be fully green on win32';
const declarationStep = 'package.json and the lock file must declare Windows in';
const npmStep = 'U23 — npm ci must succeed on win32 without --force';
const initStep = 'init succeeds in a temporary home and produces the expected tree';
const debtStep = 'Known win32 debt must not move';
const commands = {
  persistence: named(final.jobs[ids[0]], persistenceStep).run,
  fullSuite: named(final.jobs[ids[0]], fullSuiteStep).run,
  declaration: named(final.jobs[ids[1]], declarationStep).run,
  npm: named(final.jobs[ids[1]], npmStep).run,
  declared: named(final.jobs[declared], declarationStep).run,
  ciPersistence: named(ci.jobs[ids[0]], persistenceStep).run,
  ciFullSuite: named(ci.jobs[ids[0]], fullSuiteStep).run,
  ciDebtBaseline: named(ciBefore.jobs[oldIds[0]], debtStep).run,
};
assert.equal(commands.declared, commands.declaration, 'W0 repeats the declaration job exactly');
// No debt number exists anymore: the fixture's '33' is read only for the historical replay.
const historicalDebt = named(ciBefore.jobs[oldIds[0]], debtStep).env.EXPECTED_WIN32_FAILURES;
assert.equal(historicalDebt, '33', 'historical declared win32 debt');
function assertNoDebtEnv(workflow, label) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const item of [job, ...(job.steps ?? [])]) {
      assert.ok(!(item.env && 'EXPECTED_WIN32_FAILURES' in item.env), `${label} ${id}: no win32 debt allowance`);
    }
  }
}
assertNoDebtEnv(final, 'release');
assertNoDebtEnv(ci, 'CI');
// C1: the security pin is a reviewed literal. While no policy exists for the package version only
// UNREVIEWED is accepted (the gate refuses it, so nothing publishes); once
// release/security/<version>/policy.json exists only the exact lowercase sha256 of its bytes is.
function currentPolicy() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const file = join(root, 'release', 'security', version, 'policy.json');
  return existsSync(file) ? readFileSync(file) : null;
}
function assertPolicyPin(pin, policy) {
  assert.equal(typeof pin, 'string', 'security policy pin is a literal');
  assert.ok(pin === 'UNREVIEWED' || /^[0-9a-f]{64}$/.test(pin), 'security policy pin: 64 lowercase hex or UNREVIEWED, never derived');
  assert.equal(pin, policy === null ? 'UNREVIEWED' : sha(policy),
    policy === null ? 'UNREVIEWED only while no policy exists for this version' : 'pin equals sha256 of the policy bytes');
}
// Block-scalar bodies sit at ten spaces inside `run: |`; used for the exact byte exceptions.
const debtIndent = body => body.split('\n').map(line => line ? '          ' + line : '').join('\n');
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
const rejectedPersistence = named(rejected.jobs[oldIds[0]], persistenceStep).run;
// The full-suite summary is read by the same strict reader as the persistence step, on its own log.
assert.equal(commands.fullSuite.split(fixedReader.replaceAll('persistence.log', 'full.log')).length, 2,
  'full suite uses the strict persistence reader exactly once');
writeFileSync(join(evidence, 'parsed-commands.json'), JSON.stringify(commands, null, 2));
for (const [key, command] of Object.entries(commands)) {
  const path = join(admin, `${key}.bash`);
  writeFileSync(path, command);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n', path], { encoding: 'utf8', timeout });
  invocations.push({ kind: 'bash-syntax', executable: bash, argv: ['--noprofile', '--norc', '-n', path], timeout, exit: result.status });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function validate(workflow, policy = currentPolicy()) {
  workflow = withoutBrowser(workflow, true);
  const top = structuredClone(workflow);
  delete top.jobs;
  const oldTop = structuredClone(original);
  delete oldTop.jobs;
  assert.deepEqual(top, oldTop, 'unchanged trigger, permissions and concurrency');
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(Object.keys(workflow.jobs).sort(),
    [...Object.keys(original.jobs).filter(id => id !== 'windows-declared-unsupported'), declared, ...ids].sort());
  for (const [retired, next] of Object.entries(successor)) {
    assert.ok(!(retired in workflow.jobs), `retired job ${retired} is absent`);
    assert.ok(next in workflow.jobs, `successor job ${next} is present`);
  }
  const guard = structuredClone(workflow.jobs.guard);
  const securityEnv = named(guard, 'Release planning and changed-file admission').env;
  assertPolicyPin(securityEnv.RELEASE_SECURITY_POLICY_SHA256, policy);
  assert.equal(securityEnv.RELEASE_SECURITY_COMMIT, '${{ github.sha }}');
  delete securityEnv.RELEASE_SECURITY_POLICY_SHA256;
  delete securityEnv.RELEASE_SECURITY_COMMIT;
  assert.deepEqual(guard, original.jobs.guard, 'guard changes only the required security trust inputs');
  assert.deepEqual(workflow.jobs.test, withApprovedDispatchGuard(original.jobs.test, dispatchGuardSteps.release),
    'unchanged test except the approved Dispatch guard suite step');
  const guardSteps = workflow.jobs.guard.steps;
  const admission = guardSteps.indexOf(named(workflow.jobs.guard, 'Release planning and changed-file admission'));
  const token = guardSteps.indexOf(named(workflow.jobs.guard, 'NPM_TOKEN must be present'));
  assert.ok(admission >= 0 && admission < token, 'admission precedes token');
  const publish = structuredClone(workflow.jobs.publish);
  assert.deepEqual(publish.needs, ['guard', 'test', declared, ...ids], 'gate and Windows successor publish dependencies');
  publish.needs = original.jobs.publish.needs;
  assert.deepEqual(publish, withApprovedPublishReadback(original.jobs.publish),
    'unchanged publish steps, secrets and permissions except the approved registry read-back');
  for (const id of [declared, ...ids]) {
    const job = workflow.jobs[id];
    assert.equal(job.needs, 'guard', `${id}: needs guard`);
    const withoutNeeds = structuredClone(job);
    delete withoutNeeds.needs;
    assert.deepEqual(withoutNeeds, ci.jobs[id], `${id}: release equals CI except needs`);
    assert.deepEqual(withoutNeeds, approvedWindows[id], `${id}: approved Windows contract`);
    for (const item of [job, ...job.steps]) {
      for (const key of ['continue-on-error', 'if', 'strategy', 'env']) {
        assert.ok(!(key in item), `${id}: no ${key} override/bypass`);
      }
    }
    for (const step of runSteps(job)) assert.ok(['bash', 'pwsh'].includes(step.shell), `${id}: explicit shell`);
  }
  const current = readerParts(named(workflow.jobs[ids[0]], persistenceStep).run);
  const previous = readerParts(rejectedPersistence);
  assert.equal(current.reader, fixedReader, 'only the frozen corrected reader is authorized');
  assert.equal(current.prefix, previous.prefix, 'W1 pre-reader bytes unchanged');
  assert.equal(current.suffix, previous.suffix, 'W1 post-reader bytes unchanged');
  assert.equal(rejectedPersistence, named(ciBefore.jobs[oldIds[0]], persistenceStep).run, 'rejected W1 remains exact archived CI source');
  const forced = [workflow, ci].flatMap(source => [declared, ...ids].flatMap(id =>
    runSteps(source.jobs[id]).filter(s => /--force\b/.test(s.run)).map(s => [id, s.run])));
  assert.deepEqual(forced, [], 'no Windows job forces npm');
  assertNoDebtEnv(workflow, 'release');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(pkg.os, ['darwin', 'linux', 'win32']);
  assert.deepEqual(lock.packages[''].os, pkg.os, 'lock root entry declares the same os');
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
acceptance('frozen final workflow preserves non-Windows behaviour and requires the three Windows successors', 'structure', () => validate(final));
function validateReleaseHistory(workflow, source = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) {
  validate(workflow);
  assertDispatchGuardBytes(source, 'release');
  assertPublishReadbackBytes(source, 'release');
  const copy = withoutBrowser(workflow, true);
  const history = structuredClone(rejected);
  history.jobs.test = withApprovedDispatchGuard(history.jobs.test, dispatchGuardSteps.release);
  history.jobs.publish = withApprovedPublishReadback(history.jobs.publish);
  for (const item of [copy, history]) {
    const env = named(item.jobs.guard, 'Release planning and changed-file admission').env ?? {};
    delete env.RELEASE_SECURITY_POLICY_SHA256;
    delete env.RELEASE_SECURITY_COMMIT;
    for (const id of [...Object.keys(successor), declared, ...ids]) delete item.jobs[id];
    delete item.jobs.publish.needs;
  }
  assert.deepEqual(copy, history, 'release differs from the rejected source only in approved regions');
}
acceptance('release differs from the rejected source only in approved regions', 'reader-structure', () => validateReleaseHistory(final));
// C1 with a synthetic policy: once a policy exists only its exact hash is admitted, and UNREVIEWED is not.
acceptance('C1 security pin: UNREVIEWED only without a policy, then exactly the policy hash', 'structure', () => {
  const policy = Buffer.from('{"schema_version":1,"synthetic":"policy"}\n');
  const withPin = pin => {
    const copy = structuredClone(final);
    named(copy.jobs.guard, 'Release planning and changed-file admission').env.RELEASE_SECURITY_POLICY_SHA256 = pin;
    return copy;
  };
  validate(withPin('UNREVIEWED'), null);
  validate(withPin(sha(policy)), policy);
  const derived = [undefined, '', 0, '${{ vars.RELEASE_SECURITY_POLICY_SHA256 }}', "${{ hashFiles('release/security/**/policy.json') }}",
    '$(sha256sum release/security/0.2.2/policy.json)', sha(policy).toUpperCase(), sha(policy).slice(1), `${sha(policy)} `];
  for (const pin of [sha(policy), '0'.repeat(64), ...derived]) assert.throws(() => validate(withPin(pin), null), assert.AssertionError, `no policy: ${pin}`);
  for (const pin of ['UNREVIEWED', '0'.repeat(64), sha('other policy bytes'), ...derived]) {
    assert.throws(() => validate(withPin(pin), policy), assert.AssertionError, `policy present: ${pin}`);
  }
});
const windowsBoundary = '  # #901 (W1)';
function validateCIHistory(source, historicalSource = readFileSync(join(root, fixtureRoot, 'ci.before-parity.yml'), 'utf8')) {
  const workflow = parse('CI historical comparison', source);
  const persistence = named(workflow.jobs[ids[0]], persistenceStep).run;
  assert.equal(persistence, commands.persistence);
  assert.equal(sha(persistence), '50b8b702d34566ab8ef1b3ec310770ee5c32af62950d8d7ddb0996e234df6850');
  const copy = withoutBrowser(workflow, false);
  for (const id of [declared, ...ids]) {
    assert.deepEqual(copy.jobs[id], approvedWindows[id], `CI ${id}: approved Windows contract`);
    delete copy.jobs[id];
  }
  const history = structuredClone(ciBefore);
  for (const id of oldIds) delete history.jobs[id];
  history.jobs.test = withApprovedDispatchGuard(history.jobs.test, dispatchGuardSteps.ci);
  assert.deepEqual(copy, history, 'CI without its browser and Windows jobs is the historical CI without its two Windows jobs');
  // Bytes: everything before the historical Windows boundary is the historical CI except the one approved
  // header sentence and the approved Dispatch guard suite step, and everything from there to EOF is the
  // approved Windows region.
  const bytes = lf(source);
  const addition = `jobs:\n${ciBrowserAddition}`;
  assert.equal(bytes.split(addition).length, 2, 'exactly one approved browser block at the jobs boundary');
  const currentBytes = bytes.replace(addition, 'jobs:\n');
  const historical = lf(historicalSource);
  assert.equal(historical.split(windowsBoundary).length, 2, 'one historical Windows boundary');
  const prefix = historical.slice(0, historical.indexOf(windowsBoundary));
  assert.equal(prefix.split(ciHeaderBefore).length, 2, 'one historical Windows header sentence');
  assert.equal(prefix.split(`${ciDispatchGuardBefore}${dispatchGuardNext}`).length, 2, 'one historical Dispatch guard suite step');
  assert.equal(currentBytes, prefix.replace(ciHeaderBefore, () => ciHeaderAfter)
    .replace(ciDispatchGuardBefore, () => dispatchGuardAfter) + approvedWindowsRegion,
    'every CI byte outside the approved header sentence, Dispatch guard suite step and Windows region is the historical CI');
}
acceptance('CI Windows jobs match release and every other CI byte remains unchanged', 'ci-parity', () => validateCIHistory(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')));
// #1196 — the POSIX `test` job, compared between the two workflows themselves. Each file is frozen
// against its own historical fixture above, which let release.yml keep a Dispatch guard suite cap
// of 4 after CI had raised it to 8, and the first v0.2.2 tag run died on a passing suite. So the
// doctrine the Windows jobs keep: release.yml carries CI's `test` job, parsed and byte for byte,
// adding only `needs: guard`.
const testJobHead = '  test:\n    name: Full suite\n';
function testJobBytes(source, label) {
  // From `  test:` up to the next line at job indentation (a job key or a job-level comment).
  const matches = [...lf(source).matchAll(/^  test:\n(?:(?!  \S)[^\n]*\n)*/gm)];
  assert.equal(matches.length, 1, `${label}: one test job`);
  assert.ok(matches[0][0].startsWith(testJobHead), `${label}: test job header`);
  return matches[0][0];
}
function validateTestParity(ciSource, releaseSource) {
  const ciJob = parse('CI test parity', ciSource).jobs.test;
  const releaseJob = structuredClone(parse('release test parity', releaseSource).jobs.test);
  assert.ok(!('needs' in ciJob), 'CI test job: no needs');
  assert.equal(releaseJob.needs, 'guard', 'release test job: needs guard');
  delete releaseJob.needs;
  assert.deepEqual(releaseJob, ciJob, 'parsed: release test job equals CI test job except needs: guard');
  const ciBytes = testJobBytes(ciSource, 'CI');
  assert.equal(testJobBytes(releaseSource, 'release'), `${testJobHead}    needs: guard\n${ciBytes.slice(testJobHead.length)}`,
    'bytes: release test job is CI test job plus needs: guard');
}
const testParitySources = () => ['.github/workflows/ci.yml', '.github/workflows/release.yml'].map(path => lf(readFileSync(join(root, path), 'utf8')));
for (const [ending, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  acceptance(`CI and release test jobs match except needs: guard (${ending})`, 'test-parity', () => {
    validateTestParity(...testParitySources().map(source => source.replaceAll('\n', newline)));
  });
}
// [name, workflow mutated, needle, replacement, the comparison that must refuse it]
const testParityMutations = [
  ['Dispatch guard suite cap differs in release', 'release', 'release.yml carries the same lines.\n        timeout-minutes: 12\n',
    'release.yml carries the same lines.\n        timeout-minutes: 13\n', /^parsed:/],
  ['Dispatch guard suite cap differs in CI', 'CI', 'release.yml carries the same lines.\n        timeout-minutes: 12\n',
    'release.yml carries the same lines.\n        timeout-minutes: 8\n', /^parsed:/],
  ['regression suite step gains a cap in release only', 'release', '        run: npm test\n', '        run: npm test\n        timeout-minutes: 20\n', /^parsed:/],
  ['job cap differs', 'CI', '    runs-on: ${{ matrix.os }}\n    timeout-minutes: 30\n', '    runs-on: ${{ matrix.os }}\n    timeout-minutes: 45\n', /^parsed:/],
  ['matrix differs', 'release', '        os: [ubuntu-latest, macos-latest]\n', '        os: [ubuntu-latest]\n', /^parsed:/],
  ['release drops needs: guard', 'release', `${testJobHead}    needs: guard\n`, testJobHead, /needs guard/],
  ['CI gains needs: guard', 'CI', testJobHead, `${testJobHead}    needs: guard\n`, /no needs/],
  ['comment byte differs', 'release', '      # Runs after npm test because several guards gate on dist/ being built, and\n',
    '      # Runs after npm test because some guards gate on dist/ being built, and\n', /^bytes:/],
];
for (const [name, side, needle, replacement, refusal] of testParityMutations) {
  acceptance(`test job parity rejects: ${name}`, 'test-parity-mutant', () => {
    const [ciSource, releaseSource] = testParitySources();
    const changed = side === 'CI' ? [replaceOnce(ciSource, needle, replacement), releaseSource]
      : [ciSource, replaceOnce(releaseSource, needle, replacement)];
    assert.throws(() => validateTestParity(...changed), error => error instanceof assert.AssertionError && refusal.test(error.message));
  });
}

const mutants = [];
// The step each job's step-level mutants land on, found by name rather than by index.
const keyStep = { [declared]: declarationStep, [ids[0]]: fullSuiteStep, [ids[1]]: initStep };
for (const id of [declared, ...ids]) {
  mutants.push([`remove ${id}`, w => { delete w.jobs[id]; }]);
  mutants.push([`remove publish dependency ${id}`, w => { w.jobs.publish.needs = w.jobs.publish.needs.filter(n => n !== id); }]);
  for (const [label, change] of [
    ['wrong runner', j => { j['runs-on'] = j['runs-on'] === 'ubuntu-latest' ? 'windows-latest' : 'ubuntu-latest'; }],
    ['missing guard dependency', j => { delete j.needs; }],
    ['missing timeout', j => { delete j['timeout-minutes']; }],
    ['Node 22', j => { j.steps.find(step => step.uses === 'actions/setup-node@v4').with['node-version'] = '22'; }],
    ['continue-on-error job', j => { j['continue-on-error'] = true; }],
    ['always job', j => { j.if = '${{ always() }}'; }],
    ['skip job', j => { j.if = 'false'; }],
    ['continue-on-error step', j => { named(j, keyStep[id])['continue-on-error'] = true; }],
    ['always step', j => { named(j, keyStep[id]).if = '${{ always() }}'; }],
    ['missing shell', j => { delete named(j, keyStep[id]).shell; }],
    ['no-op command', j => { named(j, keyStep[id]).run = 'echo green'; }],
  ]) mutants.push([`${id}: ${label}`, w => change(w.jobs[id])]);
  for (const step of runSteps(final.jobs[id]).filter(item => /\bnpm (?:ci|pack|install)\b/.test(item.run))) {
    mutants.push([`${id}: --force inserted into "${step.name}"`, w => {
      const target = named(w.jobs[id], step.name);
      target.run = target.run.replace(/\bnpm (ci|pack|install)\b/, match => `${match} --force`);
    }]);
  }
}
mutants.push(['publish always bypass', w => { w.jobs.publish.if = '${{ always() }}'; }]);
mutants.push(['publish continue-on-error', w => { w.jobs.publish['continue-on-error'] = true; }]);
mutants.push(['old publish dependencies', w => {
  w.jobs.publish.needs = ['browser-tls', 'guard', 'test', 'windows-declared-unsupported', 'windows-persistence', 'windows-refuses'];
}]);
mutants.push(['EXPECTED_WIN32_FAILURES env added', w => { named(w.jobs[ids[0]], fullSuiteStep).env = { EXPECTED_WIN32_FAILURES: historicalDebt }; }]);
for (const id of [declared, ids[1]]) mutants.push([`${id}: declaration reverted to darwin/linux`, w => {
  const step = named(w.jobs[id], declarationStep);
  step.run = replaceOnce(step.run, `'[["darwin","linux","win32"],["darwin","linux","win32"]]'`, `'["darwin","linux"]'`);
}]);
mutants.push(['W0 U23 expecting EBADPLATFORM again', w => {
  named(w.jobs[ids[1]], npmStep).run = named(ciBefore.jobs[oldIds[1]], 'U23 — npm ci must refuse on win32 with EBADPLATFORM').run;
}]);
mutants.push(['full suite accepts skips', w => {
  const step = named(w.jobs[ids[0]], fullSuiteStep);
  step.run = replaceOnce(step.run, 'if [ "${SKIP}" != "0" ]; then', 'if [ "${SKIP}" -gt 5 ]; then');
}]);
mutants.push(['full suite ignores the runner exit', w => {
  const step = named(w.jobs[ids[0]], fullSuiteStep);
  step.run = replaceOnce(step.run, 'if [ "${RC}" != "0" ]; then', 'if false; then');
}]);
mutants.push(['full suite floor -gt 0', w => {
  const step = named(w.jobs[ids[0]], fullSuiteStep);
  step.run = replaceOnce(step.run, 'if [ "${TESTS}" -gt 200 ]; then', 'if [ "${TESTS}" -gt 0 ]; then');
}]);
mutants.push(['historical debt ratchet restored in place of the full suite', w => {
  named(w.jobs[ids[0]], fullSuiteStep).run = commands.ciDebtBaseline;
}]);
mutants.push(['changed trigger', w => { w.on.workflow_dispatch = null; }]);
mutants.push(['changed permissions', w => { w.permissions.contents = 'write'; }]);
mutants.push(['admission after token', w => { w.jobs.guard.steps.reverse(); }]);
mutants.push(['W1 changed pass floor outside reader', w => { named(w.jobs[ids[0]], persistenceStep).run = commands.persistence.replace('-gt 20', '-gt 0'); }]);
mutants.push(['W1 changed selected test glob outside reader', w => { named(w.jobs[ids[0]], persistenceStep).run = commands.persistence.replace('persistence/*.test.js', '*.test.js'); }]);
mutants.push(['W1 reverted legacy reader', w => { named(w.jobs[ids[0]], persistenceStep).run = rejectedPersistence; }]);
mutants.push(['publish registry read-back back to 6 reads', w => {
  const step = named(w.jobs.publish, 'The registry must serve the bytes we packed');
  step.run = replaceOnce(step.run, 'ATTEMPTS=49\n', 'ATTEMPTS=6\n');
}]);
mutants.push(['publish outcome step removed', w => {
  w.jobs.publish.steps = w.jobs.publish.steps.filter(step => step.name !== 'Name the outcome when the publish itself failed');
}]);
for (const [name, mutate] of mutants) acceptance(`mutant rejected: ${name}`, 'mutant', () => {
  const copy = structuredClone(final);
  mutate(copy);
  assert.throws(() => validate(copy));
});

const persistenceFiles = readdirSync(join(root, 'tests/session/persistence')).filter(n => n.endsWith('.test.ts')).sort();
assert.ok(persistenceFiles.length > 0);
const persistenceArgv = ['--test', ...persistenceFiles.map(n => `dist/tests/session/persistence/${n.replace(/\.ts$/, '.js')}`)];
const fullSuiteArgv = ['scripts/run-tests.mjs'];
const declarationArgv = ['-p', "JSON.stringify([require('./package.json').os, require('./package-lock.json').packages[''].os])"];
const argvByCommand = {
  persistence: persistenceArgv,
  ciPersistence: persistenceArgv,
  declaration: declarationArgv,
  declared: declarationArgv,
  npm: ['ci'],
  fullSuite: fullSuiteArgv,
  ciFullSuite: fullSuiteArgv,
  ciDebtBaseline: fullSuiteArgv,
};
// The historical debt body read its fixture step's own `env:` under `set -u`; nothing current has one.
const commandEnv = { ciDebtBaseline: { EXPECTED_WIN32_FAILURES: historicalDebt } };
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
      FIXTURE_OUTPUT: output, FIXTURE_RECORD: record, FIXTURE_EXIT: String(fixture.exit),
      ...(commandEnv[key] ?? {}) },
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
// #1167: the declaration is the package.json os[] and the lock root os[], serialised together; the
// ubuntu job and W0 run the same body, so both replay the same fixtures.
const declaredOs = '[["darwin","linux","win32"],["darwin","linux","win32"]]';
for (const key of ['declaration', 'declared']) {
  add(key, 'accept declared supported OS lists', `${declaredOs}\n`, 0, true);
  for (const output of ['["darwin","linux"]', '[["darwin","linux"],["darwin","linux"]]', '[["darwin","linux","win32"],["darwin","linux"]]',
    '[["darwin","linux"],["darwin","linux","win32"]]', '[["darwin","linux","win32"],null]', '[["linux","darwin","win32"],["linux","darwin","win32"]]',
    '[]', '', 'null']) {
    add(key, `reject wrong declaration ${JSON.stringify(output)}`, output, 0);
  }
  add(key, 'reject correct declaration with command failure', `${declaredOs}\n`, 1);
}
// U23 inverted: a plain install must succeed, and EBADPLATFORM anywhere refuses.
add('npm', 'accept plain successful install', 'added 137 packages, and audited 138 packages in 21s\n', 0, true);
add('npm', 'accept empty successful install', '', 0, true);
add('npm', 'reject success that logged EBADPLATFORM', 'npm error code EBADPLATFORM\n', 0);
for (const exit of [1, 2]) add('npm', `reject EBADPLATFORM exit ${exit}`, 'npm error code EBADPLATFORM\n', exit);
for (const [name, output] of [['network', 'npm error code ENETUNREACH'], ['auth', 'npm error code E401'], ['generic', 'npm error failure'], ['empty failure', '']]) {
  add('npm', `reject ${name} failure`, output, 1);
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
// #1167 — synthetic-log oracles for the full-suite step. Every body runs through the same test-owned fake
// `node`, so nothing here runs a product command or touches Windows. Only a fully green run is accepted.
const suiteFixture = (tests, fail, skip, notOk = []) =>
  `TAP version 13\n1..${tests}\n${notOk.map(name => `not ok ${name}\n`).join('')}` +
  `# tests ${tests}\n# pass ${tests - fail - skip}\n# fail ${fail}\n# skipped ${skip}\n`;
// The observed reproduction: runs 36269992125 and 36271672360 both report 1298/109/5.
const observedNotOk = ['13 - T140-dispatch-model-routing', '352 - hitl/web-auth', '634 - receipt fault boundary'];
const observedRun = suiteFixture(1298, 109, 5, observedNotOk);
const greenRun = suiteFixture(1298, 0, 0);
function runSuite(key, output, label, exit = 0) {
  const status = execute(key, { output, exit }, label);
  const { stdout, stderr } = invocations[invocations.length - 1];
  const out = stdout + stderr;
  return { exit: status, out, annotations: out.split('\n').filter(line => line.startsWith('::error::')) };
}
const mentions = (result, needle) => result.annotations.some(line => line.includes(needle));
// History only: the retired debt body still masks the failures behind its skip gate, which is why it was replaced.
acceptance('CI debt baseline masks the failure debt behind the skip gate', 'ci-debt', () => {
  const result = runSuite('ciDebtBaseline', observedRun, 'baseline observed 1298/109/5', 1);
  assert.equal(result.exit, 1, 'the job did fail');
  assert.deepEqual(result.annotations.length, 1, `one annotation only: ${JSON.stringify(result.annotations)}`);
  assert.ok(mentions(result, '5 test(s) skipped on win32'), 'and it named only the skips');
  assert.ok(!result.out.includes('--- failures this run ---'), 'the ratchet never ran');
  assert.ok(!mentions(result, 'win32 failures'), '109 was never compared to the declared 33');
});
acceptance('full suite accepts a fully green run in the release and CI bodies', 'full-suite', () => {
  for (const key of ['fullSuite', 'ciFullSuite']) {
    for (const [ending, output] of [['LF', greenRun], ['CRLF', greenRun.replaceAll('\n', '\r\n')]]) {
      const result = runSuite(key, output, `${key} green ${ending}`);
      assert.equal(result.exit, 0, `${key} ${ending}: ${result.out}`);
      assert.deepEqual(result.annotations, []);
    }
  }
});
acceptance('full suite reports the skips and the failures together', 'full-suite', () => {
  for (const key of ['fullSuite', 'ciFullSuite']) {
    const result = runSuite(key, observedRun, `${key} observed 1298/109/5`);
    assert.equal(result.exit, 1);
    assert.ok(mentions(result, '5 test(s) skipped on win32'), 'skips reported');
    assert.ok(mentions(result, '109 test(s) failed on win32'), 'failures reported');
    assert.ok(mentions(result, '2 win32 gate violation(s) reported above'));
    const marker = result.out.indexOf('--- failures this run ---');
    assert.ok(marker >= 0, 'the failing test names are emitted');
    for (const name of observedNotOk) assert.ok(result.out.slice(marker).includes(`not ok ${name}`), `named after the marker: ${name}`);
    assert.ok(!mentions(result, 'tests were enumerated'), 'an enumerated count of 1298 is not a violation');
  }
});
for (const [label, output, exit, reasons] of [
  ['a low enumeration count', suiteFixture(150, 0, 0), 0, ['only 150 tests were enumerated']],
  ['exactly 200 enumerated tests', suiteFixture(200, 0, 0), 0, ['only 200 tests were enumerated']],
  ['skips alone', suiteFixture(1298, 0, 5), 0, ['5 test(s) skipped on win32']],
  ['one failure', suiteFixture(1298, 1, 0, observedNotOk.slice(0, 1)), 0, ['1 test(s) failed on win32']],
  ['good counts with runner exit 1', greenRun, 1, ['the runner exited 1']],
  ['good counts with runner exit 7', greenRun, 7, ['the runner exited 7']],
  ['an oversized digit-only enumerated count', greenRun.replace('# tests 1298', `# tests ${'9'.repeat(25)}`), 0, ['tests were enumerated']],
  ['a low count, skips, failures and a runner exit together', suiteFixture(150, 109, 5, observedNotOk), 1,
    ['only 150 tests were enumerated', '5 test(s) skipped on win32', '109 test(s) failed on win32', 'the runner exited 1']],
]) acceptance(`full suite refuses ${label}`, 'full-suite', () => {
  const result = runSuite('fullSuite', output, `full suite ${label}`, exit);
  assert.equal(result.exit, 1, 'never a pass');
  for (const reason of reasons) assert.ok(mentions(result, reason), `expected "${reason}" in ${JSON.stringify(result.annotations)}`);
  assert.ok(mentions(result, `${reasons.length} win32 gate violation(s) reported above`), 'every reason counted, none extra');
  assert.equal(result.out.includes('--- failures this run ---'), reasons.some(reason => reason.includes('failed on win32')),
    'failing test names are listed exactly when tests failed');
});
acceptance('full suite accepts 201 enumerated tests: the floor is exactly >200', 'full-suite', () => {
  assert.equal(runSuite('fullSuite', suiteFixture(201, 0, 0), 'full suite 201 enumerated').exit, 0);
});
// The strict reader: a summary record that is absent, empty, malformed or duplicated is never read as a count.
for (const [label, output] of [
  ['an empty log', ''],
  ...['tests', 'pass', 'fail', 'skipped'].flatMap(field => {
    const record = greenRun.match(new RegExp(`^# ${field} \\d+$`, 'm'))[0];
    return [
      [`a missing ${field} record`, greenRun.replace(`${record}\n`, '')],
      [`an empty ${field} value`, greenRun.replace(record, `# ${field} `)],
      [`a non-numeric ${field} value`, greenRun.replace(record, `# ${field} nope`)],
      [`a negative ${field} value`, greenRun.replace(record, `# ${field} -1`)],
      [`a decimal ${field} value`, greenRun.replace(record, `${record}.0`)],
      [`a duplicated ${field} record`, `${greenRun}${record}\n`],
    ];
  }),
]) acceptance(`full suite refuses ${label} without reporting a count it did not read`, 'full-suite', () => {
  const result = runSuite('fullSuite', output, `full suite refuses ${label}`);
  assert.equal(result.exit, 1, 'a summary it could not read is never a pass');
  assert.ok(mentions(result, 'could not parse the TAP summary'), `expected the parse refusal in ${JSON.stringify(result.annotations)}`);
  assert.ok(!mentions(result, 'tests were enumerated') && !mentions(result, 'failed on win32'), 'no count is diagnosed from an unread field');
});
for (const [key, fixture] of [
  ['declaration', { output: '["win32"]', exit: 0 }],
  ['npm', { output: 'npm error E401', exit: 1 }],
]) acceptance(`W0 dependent group refuses after failed ${key}`, 'dependent-group', () => {
  const executed = [];
  for (const command of ['declaration', 'npm']) {
    const input = command === key ? fixture : cases.find(c => c.key === command && c.accept);
    executed.push(command);
    if (execute(command, input, `dependent-group-${key}`) !== 0) break;
  }
  assert.deepEqual(executed, ['declaration', 'npm'].slice(0, ['declaration', 'npm'].indexOf(key) + 1));
});
// The literal-checked W0 steps (pwsh steps and the installed-package bash steps) are never replayed here,
// but every approved Bash body must at least parse.
acceptance('approved Windows Bash step bodies parse', 'structure', () => {
  for (const [id, job] of Object.entries(approvedWindows)) {
    for (const step of runSteps(job).filter(item => item.shell === 'bash')) {
      const path = join(admin, `approved-${id}-${job.steps.indexOf(step)}.bash`);
      writeFileSync(path, step.run);
      const result = spawnSync(bash, ['--noprofile', '--norc', '-n', path], { encoding: 'utf8', timeout });
      invocations.push({ kind: 'bash-syntax', executable: bash, argv: ['--noprofile', '--norc', '-n', path], timeout, exit: result.status });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${id} "${step.name ?? step.run}": ${result.stderr}`);
    }
  }
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
// #1181 boot composition: the wizard suite drives an owned POSIX PTY, so like native
// capture it is a POSIX-only source entry and must never be placed on win32.
const wizardRelative = 'tests/packaging/orchestrator-boot-wizard.test.mjs';
// #1177 XRes owner supervisor fixtures: POSIX-only (owned-child signals, flock liveness),
// appended after the wizard entry and never placed on win32.
const supervisorRelative = 'tests/packaging/xres-owner-supervisor.test.mjs';
// #1162 agent-metadata suites: POSIX-only (modes, FIFOs, bash), appended after the XRes
// supervisor entry in this exact order and never placed on win32. #1171 g2c-pinned-clear is
// POSIX-only too and sits between g2c-host-contract and g2c-transport.
const agentMetadataRelatives = ['g2b-binding', 'g2c-caps-schema-unknown-pill', 'g2c-host-contract', 'g2c-pinned-clear',
  'g2c-transport', 'g3-legacy-allowlist', 'g3-reconciler-matrix', 'g3-stage-workspace-denial', 'g3-stale-fallback']
  .map(name => `tests/dispatch/agent-metadata/${name}.test.mjs`);
const agentMetadataPinnedClear = 'tests/dispatch/agent-metadata/g2c-pinned-clear.test.mjs';
// #1179 JEV suites: explicit, platform-neutral source entries on EVERY platform, win32
// included, in this exact order and ahead of the POSIX-only entries.
const jevRelatives = ['pipeline-integration', 'price-table', 'r2-acceptance-delta', 'r2-before-after',
  'refusal-path-constant', 'request-contract', 'reserve', 'response-contract', 'worker-target']
  .map(name => `tests/jev/${name}.test.mjs`);
// #1185 task-advisor efficiency suites: explicit, platform-neutral source entries on EVERY
// platform, win32 included, in this exact order, after JEV and ahead of the POSIX-only entries.
// #1171 t12-checkpoint-decoder is on every platform and sits directly after t11.
const taskAdvisorRelatives = ['t1-schema', 't10-r3-state-latency', 't11-r4-numeric', 't12-checkpoint-decoder',
  't2-decoder', 't3-dedup-gap-time', 't4-grants-binding', 't5-detectors', 't6-suppression-outcome', 't7-bounds',
  't8-r2-focused', 't9-suspicions']
  .map(name => `tests/task-advisor/efficiency/${name}.test.mjs`);
const taskAdvisorT12 = 'tests/task-advisor/efficiency/t12-checkpoint-decoder.test.mjs';
// #1182 control pure-core suite: one explicit, platform-neutral source entry on EVERY platform,
// win32 included, directly after the task-advisor entries and ahead of the POSIX-only entries.
const controlRelative = 'tests/control/core.test.mjs';
// #1167 fake-cmux win32 helper inert suite: one explicit, platform-neutral source entry on EVERY
// platform, win32 included, directly after the control entry and ahead of the POSIX-only entries.
// The fixture only places a test-owned sentinel at this path; the real helper is never imported or run.
const fakeCmuxInertRelative = 'tests/dispatch/fake-cmux-win32.inert.test.mjs';
// #1191 #1169 preservation suites: explicit source entries on EVERY platform, win32 included, in this
// exact order, directly after the fake-cmux inert entry and ahead of the POSIX-only entries. The fixture
// only places test-owned sentinels at these paths; the real suites are never imported or run here.
const preservationNames = ['preservation', 'preservation-directories'];
const preservationRelatives = preservationNames.map(name => `tests/packaging/${name}.test.mjs`);
// #1172 workflow policy suite: one explicit, platform-neutral source entry on EVERY platform, win32
// included, directly after the preservation entries and ahead of the POSIX-only entries. The fixture
// only places a test-owned sentinel at this path; the real suite is never imported or run here.
const workflowPolicyRelative = 'tests/packaging/workflow-policy.test.mjs';
// #1172 worker-inputs suite: one explicit, platform-neutral source entry on EVERY platform, win32
// included, directly after the workflow policy entry and ahead of the POSIX-only entries. The fixture
// only places a test-owned sentinel at this path; the real suite is never imported or run here.
const workerInputsRelative = 'tests/dispatch/worker-inputs.test.mjs';
// #1167 init-platform suite: one explicit source entry on EVERY platform, win32 included, directly after the
// worker-inputs entry; each OS asserts its own init branch. #1171 release-evidence suite: one explicit source
// entry on every platform directly after it, ahead of the POSIX-only entries. The fixture only places
// test-owned sentinels at these paths; the real suites are never imported or run here.
const initPlatformRelative = 'tests/packaging/init-platform.test.mjs';
const releaseEvidenceRelative = 'tests/packaging/release-evidence.test.mjs';
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
  for (const [index, path] of jevRelatives.entries()) {
    if (mode !== 'missing-jev' || index !== jevRelatives.length - 1) put(path, checks + `console.log('CALLER_JEV_SENTINEL_${index}');\nprocess.exit(${mode === 'failing-jev' && index === 0 ? 8 : 0});\n`);
  }
  for (const [index, path] of taskAdvisorRelatives.entries()) {
    if (mode === 'missing-task-advisor-t12' && path === taskAdvisorT12) continue;
    if (mode !== 'missing-task-advisor' || index !== taskAdvisorRelatives.length - 1) put(path, checks + `console.log('CALLER_TASK_ADVISOR_SENTINEL_${index}');\nprocess.exit(${(mode === 'failing-task-advisor' && index === 0) || (mode === 'failing-task-advisor-t12' && path === taskAdvisorT12) ? 8 : 0});\n`);
  }
  if (mode !== 'missing-control') put(controlRelative, checks + `console.log('CALLER_CONTROL_SENTINEL');\nprocess.exit(${mode === 'failing-control' ? 8 : 0});\n`);
  if (mode !== 'missing-fake-cmux-inert') put(fakeCmuxInertRelative, checks + `console.log('CALLER_FAKE_CMUX_INERT_SENTINEL');\nprocess.exit(${mode === 'failing-fake-cmux-inert' ? 8 : 0});\n`);
  for (const [index, path] of preservationRelatives.entries()) {
    if (mode !== `missing-${preservationNames[index]}`) put(path, checks + `console.log('CALLER_PRESERVATION_SENTINEL_${index}');\nprocess.exit(${mode === `failing-${preservationNames[index]}` ? 8 : 0});\n`);
  }
  if (mode !== 'missing-workflow-policy') put(workflowPolicyRelative, checks + `console.log('CALLER_WORKFLOW_POLICY_SENTINEL');\nprocess.exit(${mode === 'failing-workflow-policy' ? 8 : 0});\n`);
  if (mode !== 'missing-worker-inputs') put(workerInputsRelative, checks + `console.log('CALLER_WORKER_INPUTS_SENTINEL');\nprocess.exit(${mode === 'failing-worker-inputs' ? 8 : 0});\n`);
  if (mode !== 'missing-init-platform') put(initPlatformRelative, checks + `console.log('CALLER_INIT_PLATFORM_SENTINEL');\nprocess.exit(${mode === 'failing-init-platform' ? 8 : 0});\n`);
  if (mode !== 'missing-release-evidence') put(releaseEvidenceRelative, checks + `console.log('CALLER_RELEASE_EVIDENCE_SENTINEL');\nprocess.exit(${mode === 'failing-release-evidence' ? 8 : 0});\n`);
  if (mode !== 'missing-wizard') put(wizardRelative, checks + `console.log('CALLER_WIZARD_SENTINEL');\nprocess.exit(${mode === 'failing-wizard' ? 8 : 0});\n`);
  if (mode !== 'missing-supervisor') put(supervisorRelative, checks + `console.log('CALLER_SUPERVISOR_SENTINEL');\nprocess.exit(${mode === 'failing-supervisor' ? 8 : 0});\n`);
  for (const [index, path] of agentMetadataRelatives.entries()) {
    if (mode === 'missing-agent-metadata-pinned-clear' && path === agentMetadataPinnedClear) continue;
    if (mode !== 'missing-agent-metadata' || index !== agentMetadataRelatives.length - 1) put(path, checks + `console.log('CALLER_AGENT_METADATA_SENTINEL_${index}');\nprocess.exit(${(mode === 'failing-agent-metadata' && index === 0) || (mode === 'failing-agent-metadata-pinned-clear' && path === agentMetadataPinnedClear) ? 8 : 0});\n`);
  }
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
for (const [mode, expected, compiled, security, sentinel, diagnostic, onlyFailedFile] of [
  ['pass', 0, true, true, true],
  ['sentinel-fail', 1, true, true, true, /POSIX control harness failed with exit status: 1/],
  ['compiled-fail', 1, true, true, false],
  ['missing-security', 1, false, false, false, /tests[\\/]hitl[\\/]snyk-boundaries\.test\.mjs/],
  ['failing-security', 1, true, true, false],
  ['missing-admission', 1, false, false, false, /tests[\\/]packaging[\\/]release-admission\.test\.mjs/],
  ['failing-admission', 1, true, true, false],
  ['missing-native', 1, false, false, false, /tests[\\/]packaging[\\/]native-capture\.test\.mjs/],
  ['failing-native', 1, true, true, false],
  ['missing-wizard', 1, false, false, false, /tests[\\/]packaging[\\/]orchestrator-boot-wizard\.test\.mjs/],
  ['failing-wizard', 1, true, true, false],
  ['missing-supervisor', 1, false, false, false, /tests[\\/]packaging[\\/]xres-owner-supervisor\.test\.mjs/],
  ['failing-supervisor', 1, true, true, false],
  ['missing-agent-metadata', 1, false, false, false, /tests[\\/]dispatch[\\/]agent-metadata[\\/]g3-stale-fallback\.test\.mjs/],
  ['failing-agent-metadata', 1, true, true, false],
  ['missing-jev', 1, false, false, false, /tests[\\/]jev[\\/]worker-target\.test\.mjs/],
  ['failing-jev', 1, true, true, false],
  ['missing-task-advisor', 1, false, false, false, /tests[\\/]task-advisor[\\/]efficiency[\\/]t9-suspicions\.test\.mjs/],
  ['failing-task-advisor', 1, true, true, false],
  // #1171 per-entry controls for the two newly listed suites: each one alone missing or failing.
  ['missing-task-advisor-t12', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]task-advisor[\\/]efficiency[\\/]t12-checkpoint-decoder\.test\.mjs'/],
  ['failing-task-advisor-t12', 1, true, true, false, undefined, /tests[\\/]task-advisor[\\/]efficiency[\\/]t12-checkpoint-decoder\.test\.mjs$/],
  ['missing-agent-metadata-pinned-clear', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]dispatch[\\/]agent-metadata[\\/]g2c-pinned-clear\.test\.mjs'/],
  ['failing-agent-metadata-pinned-clear', 1, true, true, false, undefined, /tests[\\/]dispatch[\\/]agent-metadata[\\/]g2c-pinned-clear\.test\.mjs$/],
  // #1182 the control pure-core suite alone missing or failing, analogous to the #1171 per-entry controls.
  ['missing-control', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]control[\\/]core\.test\.mjs'/],
  ['failing-control', 1, true, true, false, undefined, /tests[\\/]control[\\/]core\.test\.mjs$/],
  // #1167 the fake-cmux win32 inert suite alone missing or failing, analogous to the #1182 control entries.
  ['missing-fake-cmux-inert', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]dispatch[\\/]fake-cmux-win32\.inert\.test\.mjs'/],
  ['failing-fake-cmux-inert', 1, true, true, false, undefined, /tests[\\/]dispatch[\\/]fake-cmux-win32\.inert\.test\.mjs$/],
  // #1191 each preservation suite alone missing or failing, analogous to the #1167 entries.
  ['missing-preservation', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]packaging[\\/]preservation\.test\.mjs'/],
  ['failing-preservation', 1, true, true, false, undefined, /tests[\\/]packaging[\\/]preservation\.test\.mjs$/],
  ['missing-preservation-directories', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]packaging[\\/]preservation-directories\.test\.mjs'/],
  ['failing-preservation-directories', 1, true, true, false, undefined, /tests[\\/]packaging[\\/]preservation-directories\.test\.mjs$/],
  // #1172 the workflow policy suite alone missing or failing, analogous to the #1191 entries.
  ['missing-workflow-policy', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]packaging[\\/]workflow-policy\.test\.mjs'/],
  ['failing-workflow-policy', 1, true, true, false, undefined, /tests[\\/]packaging[\\/]workflow-policy\.test\.mjs$/],
  // #1172 the worker-inputs suite alone missing or failing, analogous to the workflow policy entries.
  ['missing-worker-inputs', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]dispatch[\\/]worker-inputs\.test\.mjs'/],
  ['failing-worker-inputs', 1, true, true, false, undefined, /tests[\\/]dispatch[\\/]worker-inputs\.test\.mjs$/],
  // #1167 the init-platform suite and #1171 the release-evidence suite, each alone missing or failing.
  ['missing-init-platform', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]packaging[\\/]init-platform\.test\.mjs'/],
  ['failing-init-platform', 1, true, true, false, undefined, /tests[\\/]packaging[\\/]init-platform\.test\.mjs$/],
  ['missing-release-evidence', 1, false, false, false, /Could not find '[^'\n]*tests[\\/]packaging[\\/]release-evidence\.test\.mjs'/],
  ['failing-release-evidence', 1, true, true, false, undefined, /tests[\\/]packaging[\\/]release-evidence\.test\.mjs$/],
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
  assert.equal(result.stdout.includes('CALLER_WIZARD_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_SUPERVISOR_SENTINEL'), compiled);
  for (const index of agentMetadataRelatives.keys()) assert.equal(result.stdout.includes(`CALLER_AGENT_METADATA_SENTINEL_${index}`), compiled);
  for (const index of jevRelatives.keys()) assert.equal(result.stdout.includes(`CALLER_JEV_SENTINEL_${index}`), compiled);
  for (const index of taskAdvisorRelatives.keys()) assert.equal(result.stdout.includes(`CALLER_TASK_ADVISOR_SENTINEL_${index}`), compiled);
  assert.equal(result.stdout.includes('CALLER_CONTROL_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_FAKE_CMUX_INERT_SENTINEL'), compiled);
  for (const index of preservationRelatives.keys()) assert.equal(result.stdout.includes(`CALLER_PRESERVATION_SENTINEL_${index}`), compiled);
  assert.equal(result.stdout.includes('CALLER_WORKFLOW_POLICY_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_WORKER_INPUTS_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_INIT_PLATFORM_SENTINEL'), compiled);
  assert.equal(result.stdout.includes('CALLER_RELEASE_EVIDENCE_SENTINEL'), compiled);
  assert.ok(!result.stdout.includes('CALLER_UNSELECTED_MJS'), 'no automatic source .mjs discovery');
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_COMPILED_CONTROL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (security && sentinel) assert.ok(result.stdout.indexOf('CALLER_SECURITY_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_NATIVE_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_WIZARD_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_SUPERVISOR_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) for (const index of agentMetadataRelatives.keys()) {
    assert.ok(result.stdout.indexOf(`CALLER_AGENT_METADATA_SENTINEL_${index}`) < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  }
  if (compiled && sentinel) for (const index of jevRelatives.keys()) {
    assert.ok(result.stdout.indexOf(`CALLER_JEV_SENTINEL_${index}`) < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  }
  if (compiled && sentinel) for (const index of taskAdvisorRelatives.keys()) {
    assert.ok(result.stdout.indexOf(`CALLER_TASK_ADVISOR_SENTINEL_${index}`) < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  }
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_CONTROL_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_FAKE_CMUX_INERT_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) for (const index of preservationRelatives.keys()) {
    assert.ok(result.stdout.indexOf(`CALLER_PRESERVATION_SENTINEL_${index}`) < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  }
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_WORKFLOW_POLICY_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_WORKER_INPUTS_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_INIT_PLATFORM_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_RELEASE_EVIDENCE_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (diagnostic) assert.match(result.stderr, diagnostic);
  if (onlyFailedFile) {
    const failures = result.stdout.split('\n').filter(line => /^not ok \d+ - /.test(line));
    assert.equal(failures.length, 1, 'exactly one failing composed suite');
    assert.match(failures[0], onlyFailedFile);
  }
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
const callerArgv = platform => ['--test', 'dist/tests/a.test.js', 'dist/tests/nested/b.test.js', 'dist/tests/z.test.js',
  securityRelative, admissionRelative, ...jevRelatives, ...taskAdvisorRelatives, controlRelative, fakeCmuxInertRelative,
  ...preservationRelatives, workflowPolicyRelative, workerInputsRelative, initPlatformRelative, releaseEvidenceRelative,
  ...(['linux', 'darwin'].includes(platform) ? [nativeRelative, wizardRelative, supervisorRelative, ...agentMetadataRelatives] : [])];
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
    argv: callerArgv(item.platform), options: { cwd: actual.root, stdio: 'inherit' } });
  if (item.calls === 2) assert.deepEqual(actual.calls[1], { executable: process.execPath,
    argv: ['--test', harnessRelative], options: { cwd: actual.root, stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL' } });
  if (item.platform === 'win32') {
    assert.deepEqual(actual.logs, ['POSIX control harness is not run on win32; native Windows W1/W0 jobs remain separate.']);
    assert.ok(actual.logs.every(line => !/^(#|ok\b|not ok\b|TAP\b|1\.\.)/.test(line)), 'notice must not impersonate TAP results');
  } else assert.deepEqual(actual.logs, []);
  if (item.diagnostic) assert.match(actual.errors.join('\n'), item.diagnostic);
});
// #1171 explicit placement of the two newly listed suites in the exact runner's first spawn,
// measured against literal neighbours rather than inferred from the list-derived argv.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1171 t12 follows t11 and g2c-pinned-clear sits between g2c-host-contract and g2c-transport only on POSIX (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1171-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1171-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  const count = entry => spawned.filter(item => item === entry).length;
  assert.equal(count(taskAdvisorT12), 1);
  assert.equal(spawned.indexOf(taskAdvisorT12), spawned.indexOf('tests/task-advisor/efficiency/t11-r4-numeric.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/task-advisor/efficiency/t2-decoder.test.mjs'), spawned.indexOf(taskAdvisorT12) + 1);
  if (platform === 'win32') {
    assert.equal(count(agentMetadataPinnedClear), 0);
  } else {
    assert.equal(count(agentMetadataPinnedClear), 1);
    assert.equal(spawned.indexOf(agentMetadataPinnedClear), spawned.indexOf('tests/dispatch/agent-metadata/g2c-host-contract.test.mjs') + 1);
    assert.equal(spawned.indexOf('tests/dispatch/agent-metadata/g2c-transport.test.mjs'), spawned.indexOf(agentMetadataPinnedClear) + 1);
  }
});
// #1182 explicit placement of the control pure-core entry in the exact runner's first spawn: exactly
// once on every platform, directly after the last task-advisor entry, then (#1167) the fake-cmux win32
// inert entry on every platform — measured against literal neighbours, not the list-derived argv.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1182 control core follows t9-suspicions exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1182-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1182-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === 'tests/control/core.test.mjs').length, 1);
  assert.equal(spawned.indexOf('tests/control/core.test.mjs'), spawned.indexOf('tests/task-advisor/efficiency/t9-suspicions.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/dispatch/fake-cmux-win32.inert.test.mjs'), spawned.indexOf('tests/control/core.test.mjs') + 1);
});
// #1167 explicit placement of the fake-cmux win32 inert entry in the exact runner's first spawn: exactly
// once on every platform, directly after the control entry, then (#1191) the first preservation entry on
// every platform — measured against literal neighbours, not the list-derived argv.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1167 fake-cmux win32 inert follows control core exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1167-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1167-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === 'tests/dispatch/fake-cmux-win32.inert.test.mjs').length, 1);
  assert.equal(spawned.filter(item => item === 'tests/control/core.test.mjs').length, 1);
  assert.equal(spawned.indexOf('tests/dispatch/fake-cmux-win32.inert.test.mjs'), spawned.indexOf('tests/control/core.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/packaging/preservation.test.mjs'), spawned.indexOf('tests/dispatch/fake-cmux-win32.inert.test.mjs') + 1);
});
// #1191 collection guard for exactly the two #1169 preservation suites in the exact runner's first spawn:
// each exactly once on every platform, win32 included, in order directly after the fake-cmux inert entry,
// then (#1172) the workflow policy entry on every platform — literal neighbours only.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1191 preservation suites follow fake-cmux win32 inert exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1191-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1191-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === 'tests/packaging/preservation.test.mjs').length, 1);
  assert.equal(spawned.filter(item => item === 'tests/packaging/preservation-directories.test.mjs').length, 1);
  assert.equal(spawned.indexOf('tests/packaging/preservation.test.mjs'), spawned.indexOf('tests/dispatch/fake-cmux-win32.inert.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/packaging/preservation-directories.test.mjs'), spawned.indexOf('tests/packaging/preservation.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/packaging/workflow-policy.test.mjs'), spawned.indexOf('tests/packaging/preservation-directories.test.mjs') + 1);
});
// #1172 explicit placement of the workflow policy entry in the exact runner's first spawn: exactly once on
// every platform, win32 included, directly after the last preservation entry, then the worker-inputs
// entry on every platform — literal neighbours only.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1172 workflow policy follows preservation-directories exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1172-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1172-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === 'tests/packaging/workflow-policy.test.mjs').length, 1);
  assert.equal(spawned.indexOf('tests/packaging/workflow-policy.test.mjs'), spawned.indexOf('tests/packaging/preservation-directories.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/dispatch/worker-inputs.test.mjs'), spawned.indexOf('tests/packaging/workflow-policy.test.mjs') + 1);
});
// #1172 explicit placement of the worker-inputs entry in the exact runner's first spawn: exactly once on
// every platform, win32 included, directly after the workflow policy entry, then (#1167) the init-platform
// entry on every platform — literal neighbours only.
for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: #1172 worker-inputs follows workflow policy exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-1172-worker-inputs-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-1172-worker-inputs-placement', label: platform, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === 'tests/dispatch/worker-inputs.test.mjs').length, 1);
  assert.equal(spawned.filter(item => item === 'tests/packaging/workflow-policy.test.mjs').length, 1);
  assert.equal(spawned.indexOf('tests/dispatch/worker-inputs.test.mjs'), spawned.indexOf('tests/packaging/workflow-policy.test.mjs') + 1);
  assert.equal(spawned.indexOf('tests/packaging/init-platform.test.mjs'), spawned.indexOf('tests/dispatch/worker-inputs.test.mjs') + 1);
});
// #1167 explicit placement of the init-platform entry: exactly once on every platform, win32 included,
// directly after the worker-inputs entry, then (#1171) the release-evidence entry — literal neighbours only.
// #1171 the release-evidence entry: exactly once on every platform directly after init-platform, then the
// first POSIX-only entry on POSIX and nothing after it on win32.
for (const [label, entry, previous] of [
  ['#1167 init-platform follows worker-inputs', 'tests/packaging/init-platform.test.mjs', 'tests/dispatch/worker-inputs.test.mjs'],
  ['#1171 release-evidence follows init-platform', 'tests/packaging/release-evidence.test.mjs', 'tests/packaging/init-platform.test.mjs'],
]) for (const platform of ['linux', 'darwin', 'win32']) acceptance(`caller VM: ${label} exactly once ahead of the POSIX-only entries (${platform})`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-${label.replace(/[^a-z0-9]+/g, '-')}-placement-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: platform === 'win32' ? [success] : [success, success], source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-entry-placement', label: `${label} ${platform}`, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.status, 0);
  const spawned = actual.calls[0].argv;
  assert.equal(spawned.filter(item => item === entry).length, 1);
  assert.equal(spawned.indexOf(entry), spawned.indexOf(previous) + 1);
  if (entry === 'tests/packaging/init-platform.test.mjs') {
    assert.equal(spawned.indexOf('tests/packaging/release-evidence.test.mjs'), spawned.indexOf(entry) + 1);
  } else if (platform === 'win32') assert.equal(spawned.indexOf(entry), spawned.length - 1);
  else assert.equal(spawned.indexOf('tests/packaging/native-capture.test.mjs'), spawned.indexOf(entry) + 1);
});
// #1191 checkout-EOL policy for the one raw-byte-pinned preservation source. Each case commits LF bytes to a
// fresh fake repo under the private admin directory and clones it locally (no remote, no network). Git runs
// from argv arrays with HOME, global/system config and attributes, templates and hooks redirected to empty
// test-owned paths and a fake identity, so no user Git state is read. A missing Git fails, never skips.
// This proves Git's checkout policy only, not Windows ACLs or an actual Windows checkout.
const preservationPin = '5978524c38134fbba8321542fccb162ef8ff81a5b8cf426b478aed0fae4f066a';
const preservationCrlf = '2d34b32e2c6b5e6d9162ac809b3837592da4f6e6a40c9c22da752ed7348b7b0e';
const eolRule = '/bin/init/preservation.mjs text eol=lf';
const eolPinned = 'bin/init/preservation.mjs';
const eolNeighbour = 'bin/init/cli.mjs'; // real LF sibling the exact rule must not cover
const eolLookalikes = [eolNeighbour, 'preservation.mjs', `x/${eolPinned}`, `${eolPinned}.bak`];
const crlf = bytes => Buffer.from(bytes.toString('latin1').replaceAll('\n', '\r\n'), 'latin1');
let eolRepos = 0;
function eolCheckout(label, autocrlf, attributes, pinned = readFileSync(join(root, eolPinned))) {
  const git = resolveTool('git', 'WINDOWS_GATE_GIT');
  const base = mkdtempSync(join(admin, `git-eol-${eolRepos++}-`));
  const [home, hooks, template, src, dst] = ['home', 'hooks', 'template', 'src', 'dst'].map(name => join(base, name));
  for (const directory of [home, hooks, template, join(src, 'bin/init')])mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'gitconfig'), '');
  const env = { PATH: dirname(git), HOME: home, XDG_CONFIG_HOME: home, TMPDIR: base, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_ATTR_NOSYSTEM: '1', GIT_TEMPLATE_DIR: template, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@invalid', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@invalid' };
  const run = (cwd, ...args) => {
    const argv = ['-c', `core.hooksPath=${hooks}`, '-c', 'init.defaultBranch=fixture', ...args];
    const result = spawnSync(git, argv, { cwd, env, encoding: 'utf8', timeout });
    invocations.push({ kind: 'git-eol', label, executable: git, argv, timeout,
      exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  writeFileSync(join(src, eolPinned), pinned);
  writeFileSync(join(src, eolNeighbour), readFileSync(join(root, eolNeighbour)));
  if (attributes !== undefined) writeFileSync(join(src, '.gitattributes'), attributes);
  run(src, 'init', '-q');
  run(src, '-c', 'core.autocrlf=false', 'add', '-A');
  run(src, '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'fixture');
  run(base, 'clone', '-q', '--no-hardlinks', '--config', `core.autocrlf=${autocrlf}`, src, dst);
  return { pinned: readFileSync(join(dst, eolPinned)), neighbour: readFileSync(join(dst, eolNeighbour)),
    attributes: run(dst, 'check-attr', 'text', 'eol', '--', eolPinned, ...eolLookalikes) };
}
// The candidate's exact policy: the pin holds, the neighbour still follows core.autocrlf and only the exact
// path carries eol=lf.
function assertExactEolPolicy(checkout, autocrlf) {
  assert.equal(sha(checkout.pinned), preservationPin);
  const neighbour = readFileSync(join(root, eolNeighbour));
  assert.deepEqual(checkout.neighbour, autocrlf === 'true' ? crlf(neighbour) : neighbour);
  assert.equal(checkout.attributes, [`${eolPinned}: text: set\n${eolPinned}: eol: lf\n`,
    ...eolLookalikes.map(path => `${path}: text: unspecified\n${path}: eol: unspecified\n`)].join(''));
}
acceptance('Git EOL: #1191 exact rule and unchanged raw pin are the candidate inputs', 'git-eol', () => {
  const lines = readFileSync(join(root, '.gitattributes'), 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
  assert.deepEqual(lines, [eolRule]);
  assert.equal(sha(readFileSync(join(root, eolPinned))), preservationPin);
  assert.ok(readFileSync(join(root, 'tests/packaging/preservation-directories.test.mjs'), 'utf8')
    .includes(`assert.equal(sourceBefore, '${preservationPin}');\n`));
  for (const path of [eolPinned, eolNeighbour]) {
    const bytes = readFileSync(join(root, path));
    assert.ok(bytes.includes(10) && !bytes.includes(13), `${path}: LF-only source`);
  }
  assert.equal(sha(crlf(readFileSync(join(root, eolPinned)))), preservationCrlf);
});
acceptance('Git EOL: #1191 control without .gitattributes reproduces the actual-Windows CRLF hash (core.autocrlf=true)', 'git-eol', () => {
  const checkout = eolCheckout('control-true', 'true');
  assert.equal(sha(checkout.pinned), preservationCrlf);
  assert.notEqual(sha(checkout.pinned), preservationPin);
});
for (const autocrlf of ['false', 'input']) acceptance(`Git EOL: #1191 control without .gitattributes keeps the raw pin (core.autocrlf=${autocrlf})`, 'git-eol', () => {
  assert.equal(sha(eolCheckout(`control-${autocrlf}`, autocrlf).pinned), preservationPin);
});
for (const autocrlf of ['true', 'false', 'input']) acceptance(`Git EOL: #1191 exact rule restores the raw pin on that path only (core.autocrlf=${autocrlf})`, 'git-eol', () => {
  assertExactEolPolicy(eolCheckout(`fix-${autocrlf}`, autocrlf, readFileSync(join(root, '.gitattributes'))), autocrlf);
});
for (const autocrlf of ['true', 'false', 'input']) acceptance(`Git EOL: #1191 one-byte content tamper still fails the raw pin under the exact rule (core.autocrlf=${autocrlf})`, 'git-eol', () => {
  const tampered = Buffer.from(readFileSync(join(root, eolPinned)));
  tampered[0] ^= 1;
  assert.ok(![10, 13].includes(tampered[0]));
  const checkout = eolCheckout(`tamper-${autocrlf}`, autocrlf, readFileSync(join(root, '.gitattributes')), tampered);
  assert.deepEqual(checkout.pinned, tampered);
  assert.notEqual(sha(checkout.pinned), preservationPin);
});
for (const [name, rule] of [
  ['global text rewrite', '* text eol=lf\n'],
  ['unanchored basename rule', 'preservation.mjs text eol=lf\n'],
  ['exact path without eol=lf', '/bin/init/preservation.mjs text\n'],
]) acceptance(`Git EOL: #1191 exact policy rejects ${name} (core.autocrlf=true)`, 'git-eol-mutant', () => {
  const checkout = eolCheckout(`mutant-${name}`, 'true', rule);
  assert.throws(() => assertExactEolPolicy(checkout, 'true'), assert.AssertionError);
});
// #1181 wrong-platform placement of the POSIX-only wizard entry. Each mutation is applied
// to the exact runner bytes with unique-needle checks OUTSIDE assert.throws, the mutated
// runner still runs to its first spawn, and the exact caller expectation must reject it.
const wizardPosixPush = "sourceTestFiles.push('tests/packaging/native-capture.test.mjs', 'tests/packaging/orchestrator-boot-wizard.test.mjs');";
const wizardPosixDropped = "sourceTestFiles.push('tests/packaging/native-capture.test.mjs');";
const baseSourceList = "'tests/packaging/release-admission.test.mjs'];";
const jevBlock = `sourceTestFiles.push(\n${jevRelatives.map(path => `  '${path}',\n`).join('')});\n`;
const taskAdvisorBlock = `sourceTestFiles.push(\n${taskAdvisorRelatives.map(path => `  '${path}',\n`).join('')});\n`;
const supervisorPosixPush = "  sourceTestFiles.push('tests/packaging/xres-owner-supervisor.test.mjs');\n";
const posixBranchOpen = "if (process.platform === 'darwin' || process.platform === 'linux') {\n";
const agentMetadataBlock = `  sourceTestFiles.push(\n${agentMetadataRelatives.map(path => `    '${path}',\n`).join('')}  );\n`;
const controlPush = "sourceTestFiles.push('tests/control/core.test.mjs');\n";
const fakeCmuxInertPush = "sourceTestFiles.push('tests/dispatch/fake-cmux-win32.inert.test.mjs');\n";
const preservationPush = "sourceTestFiles.push('tests/packaging/preservation.test.mjs', 'tests/packaging/preservation-directories.test.mjs');\n";
const workflowPolicyPush = "sourceTestFiles.push('tests/packaging/workflow-policy.test.mjs');\n";
const workerInputsPush = "sourceTestFiles.push('tests/dispatch/worker-inputs.test.mjs');\n";
const initPlatformPush = "sourceTestFiles.push('tests/packaging/init-platform.test.mjs');\n";
const releaseEvidencePush = "sourceTestFiles.push('tests/packaging/release-evidence.test.mjs');\n";
for (const [name, mutate, platforms] of [
  ['wizard entry placed on every platform, win32 included', source => replaceOnce(replaceOnce(source, wizardPosixPush, wizardPosixDropped),
    baseSourceList, "'tests/packaging/release-admission.test.mjs', 'tests/packaging/orchestrator-boot-wizard.test.mjs'];"), ['win32', 'linux', 'darwin']],
  ['wizard entry placed on win32 only', source => replaceOnce(source, wizardPosixPush,
    `${wizardPosixDropped}\n}\nif (process.platform === 'win32') {\n  sourceTestFiles.push('tests/packaging/orchestrator-boot-wizard.test.mjs');`), ['win32', 'linux', 'darwin']],
  ['wizard entry dropped from POSIX', source => replaceOnce(source, wizardPosixPush, wizardPosixDropped), ['linux', 'darwin']],
  // #1179: every JEV suite is required on every platform, and the block must not be
  // wired POSIX-only (which would silently drop all nine from win32).
  ...jevRelatives.map(path => [`JEV suite ${path} missing`, source => replaceOnce(source, `  '${path}',\n`, ''),
    ['win32', 'linux', 'darwin']]),
  ['JEV suites wired POSIX-only', source => replaceOnce(replaceOnce(source, jevBlock, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${jevBlock.trimEnd()}`), ['win32', 'linux', 'darwin']],
  // #1185: every task-advisor efficiency suite is required on every platform, and the block
  // must not be wired POSIX-only (which would silently drop all twelve from win32).
  ...taskAdvisorRelatives.map(path => [`task-advisor suite ${path} missing`, source => replaceOnce(source, `  '${path}',\n`, ''),
    ['win32', 'linux', 'darwin']]),
  ['task-advisor suites wired POSIX-only', source => replaceOnce(replaceOnce(source, taskAdvisorBlock, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${taskAdvisorBlock.trimEnd()}`), ['win32', 'linux', 'darwin']],
  // #1171: t12 alone must stay on every platform, directly after t11.
  ['task-advisor suite t12 wired POSIX-only', source => replaceOnce(replaceOnce(source, `  '${taskAdvisorT12}',\n`, ''),
    wizardPosixPush, `${wizardPosixPush}\n  sourceTestFiles.push('${taskAdvisorT12}');`), ['win32', 'linux', 'darwin']],
  ['task-advisor suite t12 placed on win32 only', source => replaceOnce(replaceOnce(source, `  '${taskAdvisorT12}',\n`, ''),
    posixBranchOpen, `if (process.platform === 'win32') sourceTestFiles.push('${taskAdvisorT12}');\n${posixBranchOpen}`), ['win32', 'linux', 'darwin']],
  ['task-advisor suite t12 ahead of t11', source => replaceOnce(source,
    `  'tests/task-advisor/efficiency/t11-r4-numeric.test.mjs',\n  '${taskAdvisorT12}',\n`,
    `  '${taskAdvisorT12}',\n  'tests/task-advisor/efficiency/t11-r4-numeric.test.mjs',\n`), ['win32', 'linux', 'darwin']],
  // #1182: the control pure-core entry is required exactly once on every platform, directly after the
  // task-advisor block and ahead of the POSIX branch. Placing it on win32 only leaves the win32 argv
  // unchanged, so that counterfactual applies to POSIX alone.
  ['control core suite missing', source => replaceOnce(source, controlPush, ''), ['win32', 'linux', 'darwin']],
  ['control core suite duplicated', source => replaceOnce(source, controlPush, `${controlPush}${controlPush}`), ['win32', 'linux', 'darwin']],
  ['control core suite wired POSIX-only', source => replaceOnce(replaceOnce(source, controlPush, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${controlPush.trimEnd()}`), ['win32', 'linux', 'darwin']],
  ['control core suite placed on win32 only', source => replaceOnce(source, controlPush,
    `if (process.platform === 'win32') ${controlPush}`), ['linux', 'darwin']],
  ['control core suite ahead of the task-advisor suites', source => replaceOnce(replaceOnce(source, controlPush, ''),
    taskAdvisorBlock, `${controlPush}${taskAdvisorBlock}`), ['win32', 'linux', 'darwin']],
  // #1167: the fake-cmux win32 inert entry is required exactly once on every platform, directly after the
  // control entry and ahead of the POSIX branch. Placing it on win32 only leaves the win32 argv unchanged,
  // so that counterfactual applies to POSIX alone.
  ['fake-cmux win32 inert suite missing', source => replaceOnce(source, fakeCmuxInertPush, ''), ['win32', 'linux', 'darwin']],
  ['fake-cmux win32 inert suite duplicated', source => replaceOnce(source, fakeCmuxInertPush,
    `${fakeCmuxInertPush}${fakeCmuxInertPush}`), ['win32', 'linux', 'darwin']],
  ['fake-cmux win32 inert suite wired POSIX-only', source => replaceOnce(replaceOnce(source, fakeCmuxInertPush, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${fakeCmuxInertPush.trimEnd()}`), ['win32', 'linux', 'darwin']],
  ['fake-cmux win32 inert suite placed on win32 only', source => replaceOnce(source, fakeCmuxInertPush,
    `if (process.platform === 'win32') ${fakeCmuxInertPush}`), ['linux', 'darwin']],
  ['fake-cmux win32 inert suite ahead of the control core suite', source => replaceOnce(replaceOnce(source, fakeCmuxInertPush, ''),
    controlPush, `${fakeCmuxInertPush}${controlPush}`), ['win32', 'linux', 'darwin']],
  // #1191: the two preservation entries are required exactly once on every platform, in order, directly
  // after the fake-cmux inert entry and ahead of the POSIX branch. Placing them on win32 only leaves the
  // win32 argv unchanged, so that counterfactual applies to POSIX alone.
  [`preservation suite ${preservationRelatives[0]} missing`, source => replaceOnce(source, `'${preservationRelatives[0]}', `, ''),
    ['win32', 'linux', 'darwin']],
  [`preservation suite ${preservationRelatives[1]} missing`, source => replaceOnce(source, `, '${preservationRelatives[1]}'`, ''),
    ['win32', 'linux', 'darwin']],
  ['preservation suites duplicated', source => replaceOnce(source, preservationPush, `${preservationPush}${preservationPush}`),
    ['win32', 'linux', 'darwin']],
  ['preservation suites reordered', source => replaceOnce(source, preservationPush,
    "sourceTestFiles.push('tests/packaging/preservation-directories.test.mjs', 'tests/packaging/preservation.test.mjs');\n"),
    ['win32', 'linux', 'darwin']],
  ['preservation suites wired POSIX-only', source => replaceOnce(replaceOnce(source, preservationPush, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${preservationPush.trimEnd()}`), ['win32', 'linux', 'darwin']],
  ['preservation suites placed on win32 only', source => replaceOnce(source, preservationPush,
    `if (process.platform === 'win32') ${preservationPush}`), ['linux', 'darwin']],
  ['preservation suites ahead of the fake-cmux win32 inert suite', source => replaceOnce(replaceOnce(source, preservationPush, ''),
    fakeCmuxInertPush, `${preservationPush}${fakeCmuxInertPush}`), ['win32', 'linux', 'darwin']],
  // #1172: the workflow policy entry is required exactly once on every platform, directly after the
  // preservation entries and ahead of the POSIX branch. Placing it on win32 only or after the POSIX branch
  // leaves the win32 argv unchanged, so those counterfactuals apply to POSIX alone.
  ['workflow policy suite missing', source => replaceOnce(source, workflowPolicyPush, ''), ['win32', 'linux', 'darwin']],
  ['workflow policy suite duplicated', source => replaceOnce(source, workflowPolicyPush, `${workflowPolicyPush}${workflowPolicyPush}`),
    ['win32', 'linux', 'darwin']],
  ['workflow policy suite wired POSIX-only', source => replaceOnce(replaceOnce(source, workflowPolicyPush, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${workflowPolicyPush.trimEnd()}`), ['win32', 'linux', 'darwin']],
  ['workflow policy suite placed on win32 only', source => replaceOnce(source, workflowPolicyPush,
    `if (process.platform === 'win32') ${workflowPolicyPush}`), ['linux', 'darwin']],
  ['workflow policy suite ahead of the preservation suites', source => replaceOnce(replaceOnce(source, workflowPolicyPush, ''),
    preservationPush, `${workflowPolicyPush}${preservationPush}`), ['win32', 'linux', 'darwin']],
  ['workflow policy suite after the POSIX-only entries', source => replaceOnce(replaceOnce(source, workflowPolicyPush, ''),
    `${agentMetadataBlock}}\n`, `${agentMetadataBlock}}\n${workflowPolicyPush}`), ['linux', 'darwin']],
  // #1172: the worker-inputs entry is required exactly once on every platform, directly after the workflow
  // policy entry and ahead of the POSIX branch. Placing it on win32 only or after the POSIX branch leaves
  // the win32 argv unchanged, so those counterfactuals apply to POSIX alone.
  ['worker-inputs suite missing', source => replaceOnce(source, workerInputsPush, ''), ['win32', 'linux', 'darwin']],
  ['worker-inputs suite duplicated', source => replaceOnce(source, workerInputsPush, `${workerInputsPush}${workerInputsPush}`),
    ['win32', 'linux', 'darwin']],
  ['worker-inputs suite wired POSIX-only', source => replaceOnce(replaceOnce(source, workerInputsPush, ''), wizardPosixPush,
    `${wizardPosixPush}\n  ${workerInputsPush.trimEnd()}`), ['win32', 'linux', 'darwin']],
  ['worker-inputs suite placed on win32 only', source => replaceOnce(source, workerInputsPush,
    `if (process.platform === 'win32') ${workerInputsPush}`), ['linux', 'darwin']],
  ['worker-inputs suite ahead of the workflow policy suite', source => replaceOnce(replaceOnce(source, workerInputsPush, ''),
    workflowPolicyPush, `${workerInputsPush}${workflowPolicyPush}`), ['win32', 'linux', 'darwin']],
  ['worker-inputs suite after the POSIX-only entries', source => replaceOnce(replaceOnce(source, workerInputsPush, ''),
    `${agentMetadataBlock}}\n`, `${agentMetadataBlock}}\n${workerInputsPush}`), ['linux', 'darwin']],
  // #1167 / #1171: the init-platform and release-evidence entries are required exactly once on every platform,
  // in that order directly after worker-inputs and ahead of the POSIX branch. Placing one on win32 only or after
  // the POSIX branch leaves the win32 argv unchanged, so those counterfactuals apply to POSIX alone.
  ...[['init-platform', initPlatformPush, workerInputsPush], ['release-evidence', releaseEvidencePush, initPlatformPush]]
    .flatMap(([label, push, previous]) => [
      [`${label} suite missing`, source => replaceOnce(source, push, ''), ['win32', 'linux', 'darwin']],
      [`${label} suite duplicated`, source => replaceOnce(source, push, `${push}${push}`), ['win32', 'linux', 'darwin']],
      [`${label} suite wired POSIX-only`, source => replaceOnce(replaceOnce(source, push, ''), wizardPosixPush,
        `${wizardPosixPush}\n  ${push.trimEnd()}`), ['win32', 'linux', 'darwin']],
      [`${label} suite placed on win32 only`, source => replaceOnce(source, push, `if (process.platform === 'win32') ${push}`), ['linux', 'darwin']],
      [`${label} suite ahead of the entry it follows`, source => replaceOnce(replaceOnce(source, push, ''), previous, `${push}${previous}`),
        ['win32', 'linux', 'darwin']],
      [`${label} suite after the POSIX-only entries`, source => replaceOnce(replaceOnce(source, push, ''),
        `${agentMetadataBlock}}\n`, `${agentMetadataBlock}}\n${push}`), ['linux', 'darwin']],
    ]),
  // #1177: the XRes supervisor suite is required on POSIX and must never reach win32.
  ['XRes supervisor suite missing', source => replaceOnce(source, supervisorPosixPush, ''), ['linux', 'darwin']],
  ['XRes supervisor suite placed on every platform, win32 included', source => replaceOnce(replaceOnce(source, supervisorPosixPush, ''),
    posixBranchOpen, `${supervisorPosixPush.trimStart()}${posixBranchOpen}`), ['win32', 'linux', 'darwin']],
  ['XRes supervisor suite placed on win32 only', source => replaceOnce(source, supervisorPosixPush,
    `}\nif (process.platform === 'win32') {\n${supervisorPosixPush}`), ['win32', 'linux', 'darwin']],
  // #1162: the nine agent-metadata suites are required on POSIX, in this exact order after
  // the XRes supervisor entry, and must never reach win32.
  ...agentMetadataRelatives.map(path => [`agent-metadata suite ${path} missing`, source => replaceOnce(source, `    '${path}',\n`, ''),
    ['linux', 'darwin']]),
  ['agent-metadata suites placed on every platform, win32 included', source => replaceOnce(replaceOnce(source, agentMetadataBlock, ''),
    posixBranchOpen, `${agentMetadataBlock.trimStart()}${posixBranchOpen}`), ['win32', 'linux', 'darwin']],
  ['agent-metadata suites placed on win32 only', source => replaceOnce(source, agentMetadataBlock,
    `}\nif (process.platform === 'win32') {\n${agentMetadataBlock}`), ['win32', 'linux', 'darwin']],
  ['agent-metadata suites reordered', source => replaceOnce(source,
    `    '${agentMetadataRelatives[0]}',\n    '${agentMetadataRelatives[1]}',\n`,
    `    '${agentMetadataRelatives[1]}',\n    '${agentMetadataRelatives[0]}',\n`), ['linux', 'darwin']],
  ['agent-metadata suites ahead of the XRes supervisor entry', source => replaceOnce(replaceOnce(source, agentMetadataBlock, ''),
    supervisorPosixPush, `${agentMetadataBlock}${supervisorPosixPush}`), ['linux', 'darwin']],
  // #1171: g2c-pinned-clear alone must stay POSIX-only, between g2c-host-contract and g2c-transport.
  ['agent-metadata suite g2c-pinned-clear placed on every platform, win32 included', source => replaceOnce(replaceOnce(source,
    `    '${agentMetadataPinnedClear}',\n`, ''), posixBranchOpen, `sourceTestFiles.push('${agentMetadataPinnedClear}');\n${posixBranchOpen}`),
    ['win32', 'linux', 'darwin']],
  ['agent-metadata suite g2c-pinned-clear placed on win32 only', source => replaceOnce(replaceOnce(source,
    `    '${agentMetadataPinnedClear}',\n`, ''), posixBranchOpen,
    `if (process.platform === 'win32') sourceTestFiles.push('${agentMetadataPinnedClear}');\n${posixBranchOpen}`), ['win32', 'linux', 'darwin']],
  ['agent-metadata suite g2c-pinned-clear ahead of g2c-host-contract', source => replaceOnce(source,
    `    'tests/dispatch/agent-metadata/g2c-host-contract.test.mjs',\n    '${agentMetadataPinnedClear}',\n`,
    `    '${agentMetadataPinnedClear}',\n    'tests/dispatch/agent-metadata/g2c-host-contract.test.mjs',\n`), ['linux', 'darwin']],
  ['agent-metadata suite g2c-pinned-clear after g2c-transport', source => replaceOnce(source,
    `    '${agentMetadataPinnedClear}',\n    'tests/dispatch/agent-metadata/g2c-transport.test.mjs',\n`,
    `    'tests/dispatch/agent-metadata/g2c-transport.test.mjs',\n    '${agentMetadataPinnedClear}',\n`), ['linux', 'darwin']],
]) for (const platform of platforms) acceptance(`caller VM negative: ${name} is rejected on ${platform}`, 'caller-vm', () => {
  const source = mutate(callerSource);
  const config = join(admin, `caller-vm-negative-${name.replace(/[^a-z0-9]+/g, '-')}-${platform}.json`);
  writeFileSync(config, JSON.stringify({ platform, results: [success, success], source }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-vm-negative', label: `${name} ${platform}`, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(source) });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.ok(actual.calls.length >= 1, 'mutated runner reached its first spawn');
  assert.throws(() => assert.deepEqual(actual.calls[0].argv, callerArgv(platform)));
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
// On the CI browser step the acceptance env now additionally carries the required probe path,
// so the anchor for THAT site is contract-dependent and is supplied per workflow below; the
// receipt validation step's anchor is byte-identical in both and stays a plain literal.
const consoleEnvSitesFor = browserAnchor => [
  ['browser step', browserAnchor],
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
const browserMutationsFor = ({ addition, caller, run, consoleAnchor, umaskSite }) => [
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
  // The owner-only authority cookie umask of the ACCEPTANCE caller. `umask 077` is a bare line
  // that the CI-only probe compile step also carries, so this pair is anchored to the bytes that
  // follow it in the caller under test rather than to the line alone; the compile step's own
  // umask has its own negative further down.
  ['private cookie umask removed', umaskSite, umaskSite.replace(umaskLine, '')],
  ['private cookie umask widened', umaskSite, umaskSite.replace(umaskLine, '          umask 022\n')],
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
  ...consoleEnvSitesFor(consoleAnchor).flatMap(([site, anchor]) => [
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

  // #1177 — the owned supervisor's own bounds. -- THE EXACT OWNED-PROCESS REQUIREMENT IS
  // REQUIRED, AND NOW THE X SERVER ANSWERS IT. The previous attempt was rejected for accepting
  // a supporting window with no readable ownership evidence as owned; the requirement is
  // unchanged in strength and what changed is only WHO answers it, so every negative the
  // `_NET_WM_PID` window property used to carry has a same-strength replacement here against
  // the server-bound XRes answer. The property itself is gone, so the FIRST negative below is
  // that it may not come back as a fallback, and the rest pin the new answer exactly:
  //   pid-missing   -> `owner-unknown`/`owner-unreadable` may not resolve to `owned`
  //   pid-malformed -> `owner-malformed`, and a record the strict parse rejects
  //   pid-unreadable-> a non-zero/unrecognised exit, an expired bound, an exit/verdict
  //                    disagreement, and a record whose entailed fields do not agree
  //   pid-foreign   -> `owner-foreign`, and the re-comparison of BOTH reported pids against
  //                    this supervisor's own handle
  // plus the two bounds the property never had at all: the probe is a REQUIRED capability, and
  // a reduced or instrumented control may never be read as a measurement.
  ['supervisor falls back to the client-asserted _NET_WM_PID property it replaced',
    '                  proof = []\n',
    '                  state, text = read(["-id", hex(window)], "_NET_WM_PID", deadline)\n'
      + '                  if state == "ok" and text.endswith(str(wm.pid)):\n'
      + '                      return "owned"\n'
      + '                  proof = []\n'],
  ['supervisor treats a missing ownership probe as a licence to proceed',
    '              if binary is None:\n', '              if False:\n'],
  ['supervisor accepts an unset or non-executable ownership probe as one it may invoke',
    '              if not path or not os.path.isfile(path) or not os.access(path, os.X_OK):\n'
      + '                  return None\n',
    '              if False:\n                  return None\n'],
  ['supervisor reads any refusal the server answered with as ownership',
    '              if fields["verdict"] != "owned":\n',
    '              if False:\n'],
  ['supervisor accepts a record whose printed verdict and exit status disagree',
    '              if (done.returncode == 0) != (fields["verdict"] == "owned"):\n'
      + '                  return "owner-unreadable"\n', ''],
  ['supervisor accepts an exit status outside the probe\'s own owned/refused contract',
    '              if done.returncode not in (0, 2):\n'
      + '                  return "owner-unreadable"\n', ''],
  ['supervisor salvages a record its strict whole-line parse rejected',
    '              found = RECORD.match(lines[0])\n              if not found:\n'
      + '                  return "owner-unreadable"\n',
    '              found = RECORD.match(lines[0])\n              if not found:\n'
      + '                  return "owned"\n'],
  ['supervisor reads a multi-line or empty probe output as one record',
    '              if len(lines) != 1:\n                  return "owner-unreadable"\n', ''],
  ['supervisor widens the closed record pattern so an unknown refusal token is carried through',
    '              r" refusal=(?P<refusal>xres-status|num-ids-zero|num-ids-many|ids-null"\n'
      + '              r"|client-mismatch|mask-mismatch|length-range|value-null|pid-invalid|-)\\)$")\n',
    '              r" refusal=(?P<refusal>[a-z0-9-]+)\\)$")\n'],
  ['supervisor unanchors the record pattern so trailing bytes can follow the record',
    '|client-mismatch|mask-mismatch|length-range|value-null|pid-invalid|-)\\)$")',
    '|client-mismatch|mask-mismatch|length-range|value-null|pid-invalid|-)\\)")'],
  ['supervisor stops requiring the entailed fields of a record that claims owned',
    '              if (fields["probed"] != fields["window"] or fields["existence"] != "ok"\n'
      + '                      or fields["step6"] != "ok" or fields["xres_status"] != "success"\n'
      + '                      or fields["num_ids"] != "1" or fields["length"] == "-"\n'
      + '                      or fields["refusal"] != "-" or fields["version"] == "-"):\n'
      + '                  return "owner-unreadable"\n', ''],
  ['supervisor accepts more than one reported owning client',
    '                      or fields["num_ids"] != "1" or fields["length"] == "-"\n',
    '                      or fields["num_ids"] == "0" or fields["length"] == "-"\n'],
  ['supervisor stops re-comparing the server-reported pid against its own handle',
    '              if fields["pid"] == "-" or int(fields["pid"]) != wm.pid:\n'
      + '                  return "owner-unreadable"\n', ''],
  ['supervisor stops re-comparing the pid the probe was asked about against its own handle',
    '              if fields["owner_pid"] == "-" or int(fields["owner_pid"]) != wm.pid:\n'
      + '                  return "owner-unreadable"\n', ''],
  ['supervisor accepts an absent server-reported pid as this child',
    '              if fields["pid"] == "-" or int(fields["pid"]) != wm.pid:\n',
    '              if fields["pid"] != "-" and int(fields["pid"]) != wm.pid:\n'],
  ['supervisor reads a reduced or instrumented control as a measurement',
    '              if artificial(fields):\n                  return "probe-artificial"\n', ''],
  ['supervisor stops requiring the probe to report a real held server grab',
    '              return (fields["instrumented"] != "no" or fields["mode"] != "wm"\n'
      + '                      or fields["grab"] != "held")\n',
    '              return False\n'],
  ['supervisor invokes the probe in a reduced mode instead of the measuring one',
    '                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", str(wm.pid)],\n',
    '                  done = subprocess.run([binary, "--mode", "xid", "--owner-pid", str(wm.pid)],\n'],
  ['supervisor asks the probe to skip the server grab',
    '                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", str(wm.pid)],\n',
    '                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", str(wm.pid),\n'
      + '                                         "--no-grab"],\n'],
  ['supervisor asks the probe about a pid it did not start',
    '                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", str(wm.pid)],\n',
    '                  done = subprocess.run([binary, "--mode", "wm", "--owner-pid", "1"],\n'],
  ['supervisor accepts an answer about a different supporting window',
    '              if fields["window"] == "-" or int(fields["window"], 16) != window:\n'
      + '                  return "w-changed"\n', ''],
  ['supervisor drops the self-window identity check and reads the probe\'s own word for it',
    '              if fields["window"] == "-" or int(fields["window"], 16) != window:\n',
    '              if fields["window"] == "-":\n'],
  // -- the snapshot is bracketed by liveness on BOTH sides, and never widened into a lease --
  ['supervisor drops the t0 liveness check taken before the probe is spawned',
    '              if wm.poll() is not None:                                       # t0\n'
      + '                  return "exited"\n', ''],
  ['supervisor drops the t2 liveness check taken immediately after the probe is reaped',
    '              if wm.poll() is not None:                                       # t2\n'
      + '                  return "exited"\n', ''],
  ['supervisor reinterprets a child that exited inside the bracket instead of discarding it',
    '              if wm.poll() is not None:                                       # t2\n'
      + '                  return "exited"\n',
    '              if wm.poll() is not None:                                       # t2\n'
      + '                  return "owned"\n'],
  ['supervisor caches one liveness reading for both ends of the bracket',
    '              if wm.poll() is not None:                                       # t2\n',
    '              if False:                                                       # t2\n'],
  // -- the probe invocation stays bounded inside the one readiness deadline --
  ['supervisor makes the ownership probe invocation unbounded',
    '                                        timeout=min(OWNER_SECONDS, left))\n',
    '                                        timeout=None)\n'],
  ['supervisor lets the ownership probe outlive the readiness deadline',
    '                                        timeout=min(OWNER_SECONDS, left))\n',
    '                                        timeout=OWNER_SECONDS)\n'],
  ['supervisor raises the ownership probe bound past the readiness deadline',
    '          OWNER_SECONDS = 15.0\n', '          OWNER_SECONDS = 600.0\n'],
  ['supervisor reads an expired ownership bound as an absence rather than a refusal',
    '                         True, OWNER_EVIDENCE_BYTES, "probe")\n'
      + '                  return "owner-unreadable"\n',
    '                         True, OWNER_EVIDENCE_BYTES, "probe")\n'
      + '                  return "owned"\n'],
  ['supervisor reads a probe it could not spawn as ownership',
    '                         b"", b"", False, OWNER_EVIDENCE_BYTES, "probe")\n'
      + '                  return "owner-unreadable"\n',
    '                         b"", b"", False, OWNER_EVIDENCE_BYTES, "probe")\n'
      + '                  return "owned"\n'],
  ['supervisor reads a deadline that had already passed as ownership',
    '                         OWNER_EVIDENCE_BYTES, "probe")\n                  return "timeout"\n',
    '                         OWNER_EVIDENCE_BYTES, "probe")\n                  return "owned"\n'],
  // -- the ownership answer is the ONLY thing that can return `owned`, and it is named as such
  ['supervisor returns owned without asking the server at all',
    '                  verdict = xres_owned(binary, wm, window, deadline, proof)\n',
    '                  verdict = "owned"\n'],
  ['supervisor reports unproven ownership as the server-bound exact answer',
    '                          "xres-exact-owned-client" if ready == "owned" else "unproven",\n',
    '                          "xres-exact-owned-client",\n'],
  ['supervisor keeps the ownership probe record out of the failed CI output',
    '                      note("wm-ownership-probe (%s)" % seen)\n', '                      pass\n'],
  ['supervisor stops asking the ownership probe to record what it did',
    '                  verdict = xres_owned(binary, wm, window, deadline, proof)\n',
    '                  verdict = xres_owned(binary, wm, window, deadline)\n'],
  ['supervisor lets the ownership record relax the refusal it exists to explain',
    '              if artificial(fields):\n',
    '              if artificial(fields) and not evidence:\n'],
  ['supervisor truncates the ownership record at the xprop cap that would hide the reason',
    '          OWNER_EVIDENCE_BYTES = 768\n', '          OWNER_EVIDENCE_BYTES = 40\n'],
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
  // The trailing liveness re-check this used to pin is now the probe bracket's t2 poll, which
  // is strictly tighter and has its own negatives above. What is left to pin here is the
  // readiness loop's return itself: the ownership answer may not be discarded at the last step.
  ['supervisor discards the ownership answer at the readiness return',
    '                  return verdict\n', '                  return "owned"\n'],
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
    '          sudo apt-get install -y --no-install-recommends \\\n'
      + '            openbox x11-utils libxres-dev libx11-dev\n',
    '          sudo apt-get install -y openbox x11-utils libxres-dev libx11-dev\n'],
  ['window manager install stops proving the tools it added are present',
    '          command -v openbox\n          command -v xprop\n', ''],
  ['supervisor interpreter is no longer proved present',
    '          command -v python3\n', ''],
  // -- and the CI-only XRes probe compile step: official libraries, measured provenance, no
  // install, no privilege, and a binary that cannot be skipped or replaced by a checked-in one.
  ['CI-only XRes probe compile step removed', ciXresCompile, ''],
  ['XRes probe compiler is no longer proved present',
    '          command -v cc\n', ''],
  ['XRes build dependencies dropped from the CI-only install',
    '            openbox x11-utils libxres-dev libx11-dev\n',
    '            openbox x11-utils\n'],
  ['XRes probe compiled against something other than the two official libraries',
    '            scripts/ci/xres-owner.c -lXRes -lX11\n',
    '            scripts/ci/xres-owner.c -lXRes -lX11 -lXpriv\n'],
  ['XRes probe compiled from a source other than the frozen prototype-validated one',
    '            scripts/ci/xres-owner.c -lXRes -lX11\n',
    '            "$RUNNER_TEMP/xres/other.c" -lXRes -lX11\n'],
  ['XRes probe compile stops failing on a compiler error',
    '          cc -O2 -Wall -Wextra -o "$RUNNER_TEMP/xres/xres-owner" \\\n',
    '          cc -O2 -Wall -Wextra -o "$RUNNER_TEMP/xres/xres-owner" || true \\\n'],
  ['XRes probe compile stops proving it produced an executable',
    '          test -x "$RUNNER_TEMP/xres/xres-owner"\n', ''],
  ['XRes probe is built outside the owner-only runner temp',
    '          mkdir -p "$RUNNER_TEMP/xres"\n', '          mkdir -p /tmp/xres\n'],
  ['XRes probe directory is created without the owner-only umask',
    '          set -euo pipefail\n          umask 077\n          mkdir -p "$RUNNER_TEMP/xres"\n',
    '          set -euo pipefail\n          mkdir -p "$RUNNER_TEMP/xres"\n'],
  ['XRes provenance is asserted instead of measured',
    '          dpkg-query -W -f=\'${Package} ${Version}\\n\' libxres1 libxres-dev libx11-dev\n',
    '          echo "libxres1 2:1.2.1-1"\n'],
  ['XRes header provenance is no longer hashed',
    '          sha256sum "$header"\n', ''],
  ['XRes header presence is no longer required',
    '          test -f "$header"\n', ''],
  ['XRes source and binary hashes are no longer recorded',
    '          sha256sum scripts/ci/xres-owner.c "$RUNNER_TEMP/xres/xres-owner"\n', ''],
  ['XRes probe compile takes root it was never approved for',
    '          cc -O2 -Wall -Wextra -o "$RUNNER_TEMP/xres/xres-owner" \\\n',
    '          sudo cc -O2 -Wall -Wextra -o "$RUNNER_TEMP/xres/xres-owner" \\\n'],
  ['XRes probe compile is charged to the acceptance step budget instead of its own step',
    `${ciXresCompile}${browserCallerStep}`, `${browserCallerStep}${ciXresCompile}`],
  // -- the acceptance step's required probe env var: present, exact, and never optional --
  ['acceptance step stops naming the compiled ownership probe', ciXresEnv, ''],
  ['acceptance step points the ownership probe env at something it did not compile',
    '          XRES_OWNER_BIN: ${{ runner.temp }}/xres/xres-owner\n',
    '          XRES_OWNER_BIN: /usr/local/bin/xres-owner\n'],

  // #1177 THE PRESERVED INITIAL-READ EVIDENCE. The measured refusal this corrects reported
  // only that the initial `_NET_SUPPORTING_WM_CHECK` state "came back unknown": the probe's
  // exit status, its property response and its diagnostic stderr were all discarded at the
  // point of reading, so a red job named the gap and carried nothing to act on. The record
  // is bounded, sanitized, emitted on every outcome and read by NOTHING, so each half of
  // that is its own negative - the evidence may not disappear again, and it may not start
  // relaxing the refusal it exists to explain.
  // `stderr=subprocess.PIPE` now appears on the xprop read AND on the ownership probe, so each
  // is anchored to the bound line that follows it and both are pinned separately.
  ['supervisor discards the initial probe stderr again',
    '                                        stderr=subprocess.PIPE,\n'
      + '                                        timeout=min(PROBE_SECONDS, left))\n',
    '                                        stderr=subprocess.DEVNULL,\n'
      + '                                        timeout=min(PROBE_SECONDS, left))\n'],
  ['supervisor discards the ownership probe stderr',
    '                                        stderr=subprocess.PIPE,\n'
      + '                                        timeout=min(OWNER_SECONDS, left))\n',
    '                                        stderr=subprocess.DEVNULL,\n'
      + '                                        timeout=min(OWNER_SECONDS, left))\n'],
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
  // `sanitize` now takes the cap as a parameter so the longer ownership record is not truncated
  // at the xprop bound. It is still a BOUND on every caller, the truncation is still its own
  // field, and the default is still the unchanged xprop cap - so each of those is pinned here
  // against the parameterised lines rather than the old hard-coded constant.
  ['supervisor reports a truncated probe stream as a complete one',
    '              return (shown, len(data), len(data) > cap)\n',
    '              return (shown, len(data), False)\n'],
  ['supervisor stops reporting how much the probe actually printed',
    '              return (shown, len(data), len(data) > cap)\n',
    '              return (shown, len(shown), len(data) > cap)\n'],
  ['supervisor lets one probe record grow without bound',
    '              kept = data[:cap]\n',
    '              kept = data\n'],
  ['supervisor makes the per-stream cap optional so a caller can drop the bound',
    '              kept = data[:cap]\n',
    '              kept = data[:cap] if cap else data\n'],
  ['supervisor changes the default cap every existing xprop caller relies on',
    '          def sanitize(raw, redact, cap=EVIDENCE_BYTES):\n',
    '          def sanitize(raw, redact, cap=OWNER_EVIDENCE_BYTES):\n'],
  ['supervisor changes the default record cap every existing xprop caller relies on',
    '          def record(evidence, name, status, out, err, timed_out, cap=EVIDENCE_BYTES,\n',
    '          def record(evidence, name, status, out, err, timed_out, cap=OWNER_EVIDENCE_BYTES,\n'],
  ['supervisor mislabels the ownership subprocess as a window property',
    '                     label="property"):\n', '                     label="probe"):\n'],
  ['supervisor drops the label that distinguishes a subprocess record from a property one',
    '              evidence.append(\'%s=%s status=%s timed-out=%s stdout-bytes=%d\'\n',
    '              evidence.append(\'property=%s status=%s timed-out=%s stdout-bytes=%d\'\n'],
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
    '              kept = data[:cap]\n',
    '              kept = data.decode("utf-8", "replace")[:cap].encode("utf-8")\n'],
  ['supervisor path redaction stops matching the raw probe bytes',
    '          PATHLIKE = re.compile(b"/[^ ]*")\n',
    '          PATHLIKE = re.compile("/[^ ]*")\n'],
  ['supervisor redacts the exact property response the refusal has to explain',
    '              shown_out, out_bytes, out_cut = sanitize(out, False, cap)\n',
    '              shown_out, out_bytes, out_cut = sanitize(out, True, cap)\n'],
  ['supervisor stops redacting the diagnostic stream it passes the cap to',
    '              shown_err, err_bytes, err_cut = sanitize(err, True, cap)\n',
    '              shown_err, err_bytes, err_cut = sanitize(err, False, cap)\n'],
  ['supervisor ignores the cap a caller asked the record to bound its streams by',
    '              shown_out, out_bytes, out_cut = sanitize(out, False, cap)\n'
      + '              shown_err, err_bytes, err_cut = sanitize(err, True, cap)\n',
    '              shown_out, out_bytes, out_cut = sanitize(out, False)\n'
      + '              shown_err, err_bytes, err_cut = sanitize(err, True)\n'],
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
const publishDependencies = ['browser-tls', 'guard', 'test', declared, ...ids];
const publishNeeds = `    needs: [${publishDependencies.join(', ')}]\n`;
// The current pin line, whatever literal it holds (UNREVIEWED today, the reviewed hash later); validate() judges it.
const policyPinLine = lf(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')).match(/^          RELEASE_SECURITY_POLICY_SHA256: [^\n]*\n/m)[0];
const releaseBrowserMutations = [
  ['missing guard browser dependency', '    needs: [browser-tls]\n', ''],
  ['extra guard dependency', '    needs: [browser-tls]\n', '    needs: [browser-tls, test]\n'],
  ...publishDependencies.map(id => [`missing publish ${id}`, publishNeeds, `    needs: [${publishDependencies.filter(value => value !== id).join(', ')}]\n`]),
  ['extra publish dependency', publishNeeds, `    needs: [${[...publishDependencies, 'unapproved'].join(', ')}]\n`],
  ['guard skip', '  guard:\n', '  guard:\n    if: false\n'],
  ['guard always', '  guard:\n', '  guard:\n    if: always()\n'],
  ['guard continue-on-error', '  guard:\n', '  guard:\n    continue-on-error: true\n'],
  ['publish skip', '  publish:\n', '  publish:\n    if: false\n'],
  ['policy trust input missing', policyPinLine, ''],
  ['policy trust input changed', policyPinLine, '          RELEASE_SECURITY_POLICY_SHA256: approved\n'],
  ['policy trust input derived from the tree', policyPinLine, "          RELEASE_SECURITY_POLICY_SHA256: ${{ hashFiles('release/security/**/policy.json') }}\n"],
  ['policy trust input from a repository variable', policyPinLine, '          RELEASE_SECURITY_POLICY_SHA256: ${{ vars.RELEASE_SECURITY_POLICY_SHA256 }}\n'],
  ['policy trust input wrong hex', policyPinLine, `          RELEASE_SECURITY_POLICY_SHA256: ${'0'.repeat(64)}\n`],
  ['commit trust input missing', '          RELEASE_SECURITY_COMMIT: ${{ github.sha }}\n', ''],
  ['commit trust input changed', '          RELEASE_SECURITY_COMMIT: ${{ github.sha }}\n', '          RELEASE_SECURITY_COMMIT: main\n'],
  ['original release version input changed', '          RELEASE_VERSION: ${{ steps.identity.outputs.version }}\n', '          RELEASE_VERSION: arbitrary\n'],
  ['publish authentication changed', '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n', '          NODE_AUTH_TOKEN: arbitrary\n'],
  // #1171 — the Dispatch guard suite step must stay the approved bytes CI carries too.
  ['Dispatch guard suite cap back to 4', 'release.yml carries the same lines.\n        timeout-minutes: 12\n',
    'release.yml carries the same lines.\n        timeout-minutes: 4\n'],
  ['Dispatch guard suite step differs from CI', '        # measured time and still catches a real hang. release.yml carries the same lines.\n',
    '        # measured time and still catches a real hang.\n'],
  // #1196 — the approved publish outcome step and registry read-back, byte for byte.
  ['registry read-back budget back to 6 reads', '          ATTEMPTS=49\n', '          ATTEMPTS=6\n'],
  ['registry read-back interval back to 10 s', '          INTERVAL=15\n', '          INTERVAL=10\n'],
  ['registry read-back reads every failure as a 404', '            if grep -q \'E404\' "${RUNNER_TEMP}/readback.err"; then\n', '            if true; then\n'],
  ['registry read-back stops printing each read',
    '              echo "read ${attempt}/${ATTEMPTS}: registry answered ${ANSWER}; waiting ${INTERVAL}s"\n', ''],
  ['registry read-back stops naming the last answer', '; the last answer was ${ANSWER}. The publish is NOT confirmed.', '. The publish is NOT confirmed.'],
  ['registry read-back skipped', '      - name: The registry must serve the bytes we packed\n',
    '      - name: The registry must serve the bytes we packed\n        if: false\n'],
  ['publish step loses its id', '        id: publish\n', ''],
  ['publish outcome step always runs', "        if: failure() && steps.publish.outcome == 'failure'\n", '        if: always()\n'],
  ['publish outcome step removed', publishReadbackAfter.slice(publishReadbackAfter.indexOf('      # #1196, modelled on'),
    publishReadbackAfter.indexOf('      # The verification that matters.')), ''],
  ['registry read-back comment byte changed', '      # #1196 — WHY THE BUDGET IS 12 MINUTES.', '      # #1196 — WHY THE BUDGET IS 15 MINUTES.'],
];
// #1167 — CI's copy of the approved Windows region. Each negative relaxes exactly one bound the full-suite
// gate or its neighbours must hold; every one must be refused by the byte and parsed comparisons.
const ciFullSuiteMutations = [
  ['full-suite enumeration floor dropped', '          if [ "${TESTS}" -gt 200 ]; then\n', '          if [ "${TESTS}" -gt 0 ]; then\n'],
  ['full-suite enumeration success condition inverted so a comparison error stops being a violation',
    '          if [ "${TESTS}" -gt 200 ]; then\n            :\n          else\n', '          if [ "${TESTS}" -le 200 ]; then\n'],
  ['full-suite skips become an accepted currency', '          if [ "${SKIP}" != "0" ]; then\n', '          if [ "${SKIP}" -gt 5 ]; then\n'],
  ['full-suite failures become an allowance', '          if [ "${FAIL}" != "0" ]; then\n', '          if [ "${FAIL}" -gt 33 ]; then\n'],
  ['full-suite runner exit ignored', '          if [ "${RC}" != "0" ]; then\n', '          if false; then\n'],
  ['full-suite collected violations no longer fail the job',
    '          [ "${VIOLATIONS}" = "0" ] || { echo "::error::${VIOLATIONS} win32 gate violation(s) reported above; every applicable diagnostic ran before this failure."; exit 1; }\n',
    '          echo "${VIOLATIONS} win32 gate violation(s) reported above."\n'],
  ['full-suite fail-closed summary parsing dropped',
    '          [ -n "${TESTS}" ] && [ -n "${PASS}" ] && [ -n "${FAIL}" ] && [ -n "${SKIP}" ] \\\n'
      + '            || { echo "::error::could not parse the TAP summary; refusing to report a vacuous pass."; exit 1; }\n', ''],
  ['full-suite reader accepts malformed records',
    '                if ($0 !~ ("^# " key " [0-9]+$")) malformed = 1\n                else count = $3\n              }\n'
      + '              END { if (records == 1 && !malformed) print count }\n            \' "${RUNNER_TEMP}/full.log"\n',
    '                count = $3\n              }\n'
      + '              END { if (records == 1 && !malformed) print count }\n            \' "${RUNNER_TEMP}/full.log"\n'],
  ['full-suite debt allowance reintroduced', `      - name: ${fullSuiteStep}\n        shell: bash\n`,
    `      - name: ${fullSuiteStep}\n        shell: bash\n        env:\n          EXPECTED_WIN32_FAILURES: '33'\n`],
  ['W1 install forced again', '      - name: Install dependencies (plain npm ci; Windows is declared in os[])\n        shell: bash\n        run: npm ci\n',
    '      - name: Install dependencies (plain npm ci; Windows is declared in os[])\n        shell: bash\n        run: npm ci --force\n'],
  ['W0 U23 expects a failed install again', '          [ "$RC" = "0" ] || { echo "::error::npm ci failed on win32', '          [ "$RC" != "0" ] || { echo "::error::npm ci failed on win32'],
  ['W0 LF checkout dropped', '    timeout-minutes: 20\n    steps:\n      - name: Check out with LF endings, as the published tarball has them\n        shell: bash\n        run: git config --global core.autocrlf false\n',
    '    timeout-minutes: 20\n    steps:\n      - name: Check out with LF endings, as the published tarball has them\n        shell: bash\n        run: git config --global core.autocrlf true\n'],
  ['historical debt step restored in place of the full suite', debtIndent(commands.ciFullSuite), debtIndent(commands.ciDebtBaseline)],
  ['Windows header sentence changed', '# the live-integration guards above. Windows is measured', '# the live-integration guards above. Windows is observed'],
  ['Windows region comment byte changed', '  # #901 (W1), now the whole suite', '  # #901 (W1), now the entire suite'],
];
// The acceptance caller's `umask 077` plus the one line that follows it in each contract, so
// the cookie-umask negatives land on the CALLER and not on the CI-only compile step, which
// carries the same bare line and has its own negative.
const ciDiagnosticFirstLine = `${ciDiagnosticRun.split('\n', 1)[0]}\n`;
assert.ok(ciDiagnosticRun.startsWith(ciDiagnosticFirstLine), 'CI caller body first line');
const callerContracts = {
  CI: { addition: ciBrowserAddition, caller: ciHeadedCaller, run: ciDiagnosticRun,
    consoleAnchor: `${ciXresEnv}${headedRationaleAnchor}`,
    umaskSite: `${umaskLine}${ciDiagnosticFirstLine}` },
  // #1177: release.yml runs the CI job byte for byte, so its negatives are the CI contract's.
  release: { addition: ciBrowserAddition, caller: ciHeadedCaller, run: ciDiagnosticRun,
    consoleAnchor: `${ciXresEnv}${headedRationaleAnchor}`,
    umaskSite: `${umaskLine}${ciDiagnosticFirstLine}` },
};
for (const [workflowName, path] of [['CI', '.github/workflows/ci.yml'], ['release', '.github/workflows/release.yml']]) {
  const source = lf(readFileSync(join(root, path), 'utf8'));
  const browserMutations = browserMutationsFor(callerContracts[workflowName]);
  for (const [ending, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const encode = value => lf(value).replaceAll('\n', newline);
    const check = value => workflowName === 'CI'
      ? validateCIHistory(value, encode(readFileSync(join(root, fixtureRoot, 'ci.before-parity.yml'), 'utf8')))
      : validateReleaseHistory(parse(`${workflowName} ${ending} variant`, value), value);
    acceptance(`browser projection accepts ${workflowName} ${ending}`, 'browser-projection', () => check(encode(source)));
    const mutations = workflowName === 'CI' ? [
      ...browserMutations,
      ...ciDiagnosticMutations,
      ...ciFullSuiteMutations,
      ['unrelated comment byte changed', '# #894.', '# #894 changed.'],
    ] : [...browserMutations, ...ciDiagnosticMutations, ...releaseBrowserMutations];
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
      'Windows behaviour is measured only by the windows-suite/windows-installed CI jobs; this harness checks their YAML.',
      'YAML fixtures are not product security clearance. Exact-source Snyk remains blocked by known tls652; no retry/upload.'],
  }, null, 2));
  assert.deepEqual(afterHashes, before, 'all hashed product, baseline and CI sources unchanged');
});
