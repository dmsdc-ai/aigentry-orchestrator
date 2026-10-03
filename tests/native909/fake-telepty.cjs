'use strict';
// fake-telepty.cjs — test-only stand-in for a `telepty allow --id <sid>` front process
// (#909 native CI). It is never the product and never runs from the repo path: the
// harness copies these bytes into a run-private temp dir as the TELEPTY locator, and
// spawns `node <that copy> allow --id <fixture sid> ...` so the real `ps` row has the
// exact shape platform::session_pid looks for.
//
// It does nothing: no network, no auth, no files, no telepty. It prints one READY
// handshake line, then lives until its stdin (a pipe held by the harness) reaches EOF.
// The lifetime cap is a backstop so an abandoned child cannot outlive a crashed run.

if (process.env.NT909_FAKE_CHILD !== '1') process.exit(64);
const args = process.argv.slice(2);
if (!args.some((a) => a === '--id' || a.startsWith('--id='))) process.exit(64);

const LIFETIME_MS = 180000;
const cap = setTimeout(() => process.exit(70), LIFETIME_MS);

process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  clearTimeout(cap);
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

process.stdout.write('READY ' + process.pid + '\n');
