# cmux-claude-wrapper: the NODE_OPTIONS restore shim lives in `$TMPDIR`, macOS purges it after 3 days, and every node child of a long-lived claude session then dies at preload

**Status: DRAFT — not posted.** Target: `manaflow-ai/cmux`. Prepared by aigentry-orchestrator
task #1075 (2026-09-05); external publishing is the user's call.

## Environment (everything below was measured on this build)

| item | value |
|---|---|
| cmux.app | 0.64.20 (CFBundleVersion 100), installed at `/Applications/cmux.app` |
| wrapper | `/Applications/cmux.app/Contents/Resources/bin/cmux-claude-wrapper`, 1031 lines, sha256 `15e3574a1ee291ebee5cc2498d05e943a3d20486331d4114f1bbd1a6c11f4123` |
| macOS | 26.4.1 (25E253), Darwin 25.4.0 |
| claude | native `~/.local/bin/claude`; the failing children are node processes it spawns |

Line numbers refer to that wrapper. The function is not in the public `cmux` checkout we have
(nightly); it lives only in the installed bundle.

## Summary

The wrapper writes a small CommonJS "restore" module into `$TMPDIR` **once, at claude launch**, and
exports `NODE_OPTIONS='--require=<that file> --max-old-space-size=4096'` into the claude process.
macOS's temp cleaners remove `$TMPDIR` entries after 3 idle days. A claude session that lives longer
than that keeps a `--require` pointing at a file that no longer exists. Node applies `--require`
before anything else, so from that moment **every node process the session spawns dies at preload**:

```
Error: Cannot find module '/var/folders/vn/…/T/cmux-claude-node-options/restore-node-options.cjs'
```

Stop hooks, `npm test`, `node -p 1`, `telepty`, every node-based MCP server restart. The parent
claude keeps running (it loaded the module days ago), which is what makes this look like an
intermittent, session-specific breakage rather than a launcher defect. A fresh claude launch
recreates the file, so the failure always lands on the longest-lived session.

## Mechanism, with the wrapper's line numbers

1. `ensure_node_options_restore_module()` — **:628–657**
   - `guard_dir="${TMPDIR:-/tmp}"` → `"${guard_dir%/}/cmux-claude-node-options"` (**:629–630**), so
     the file is `$TMPDIR/cmux-claude-node-options/restore-node-options.cjs` (**:631**).
   - The module is written from a heredoc (**:635–644**, content **:636–643**) through a `mktemp`
     sibling, `chmod 0644`, `cmp -s` against an existing file, `mv -f` (**:633–657**); the function
     prints the path (**:657**). It runs only from the launch path — nothing re-runs it later.
2. `install_cmux_node_options()` — **:727–741** — calls it (**:729**), records the caller's original
   `NODE_OPTIONS` in `CMUX_ORIGINAL_NODE_OPTIONS{,_PRESENT}` (**:733–738**) and exports
   `NODE_OPTIONS="$(merge_node_options "$guard_path")"` (**:740**). Called at **:845** and **:881**.
3. The module itself (**:636–643**), 340 bytes:

   ```js
   const hadOriginalNodeOptions = process.env.CMUX_ORIGINAL_NODE_OPTIONS_PRESENT === "1";
   if (hadOriginalNodeOptions) {
     process.env.NODE_OPTIONS = process.env.CMUX_ORIGINAL_NODE_OPTIONS ?? "";
   } else {
     delete process.env.NODE_OPTIONS;
   }
   delete process.env.CMUX_ORIGINAL_NODE_OPTIONS;
   delete process.env.CMUX_ORIGINAL_NODE_OPTIONS_PRESENT;
   ```

   Its job is to strip the wrapper's `NODE_OPTIONS` from every node grandchild so the
   `--max-old-space-size=4096` and the `--require` apply to claude's direct node children only.
4. The purge. Two launchd jobs clean per-user temp directories on this macOS:
   - `com.apple.tmp_cleaner` (`/usr/libexec/tmp_cleaner`, `StartCalendarInterval` hour 0). Its
     embedded script sets `daily_clean_tmps_days="3"` and runs `find … -atime +3 -mtime +3 -ctime +3`
     (and `-empty -mtime +3` for directories).
   - `com.apple.bsd.dirhelper` (`/usr/libexec/dirhelper`, `CLEAN_FILES_OLDER_THAN_DAYS=3`,
     `StartCalendarInterval` 03:35).

   The wrapper's file has mtime and ctime frozen at launch time. On 2026-08-30 the file was gone from
   a session that had been spawning node children continuously; the directory
   `cmux-claude-node-options/` was left behind **empty**, its mtime being the purge time. Which of the
   two cleaners fired was not determined.

## Repro

1. In cmux, launch `claude` (the wrapper runs). Inside the session:
   ```sh
   echo "$NODE_OPTIONS"
   # --require=/var/folders/…/T/cmux-claude-node-options/restore-node-options.cjs --max-old-space-size=4096
   node -p 1     # → 1
   ```
2. Either wait 3+ days with the session open, or simulate the purge. **Warning:** this breaks every
   node child of every cmux-launched claude on the machine until the file is recreated:
   ```sh
   rm "$TMPDIR/cmux-claude-node-options/restore-node-options.cjs"
   ```
3. In the same session:
   ```sh
   node -p 1
   # Error: Cannot find module '/var/folders/…/T/cmux-claude-node-options/restore-node-options.cjs'
   # … code: 'MODULE_NOT_FOUND' … exit 1
   ```
   Every stop hook, `npm test`, `telepty` call and MCP server restart fails the same way. The claude
   process itself is unaffected.
4. Launch a second claude in another cmux workspace: the file is back (step 1 of the mechanism) and
   the first session recovers — until the next purge.

## Fixes upstream can pick (either one closes it)

1. **Write the shim somewhere no cleaner touches.** Replace the `guard_dir` at **:629–630** with a
   per-user, non-temporary location, e.g. `~/Library/Application Support/cmux/node-options/` (or
   `$XDG_STATE_HOME/cmux/` where set). The rest of `ensure_node_options_restore_module()` (mktemp,
   cmp, mv) works unchanged. This is the smaller change and removes the time bomb entirely.
2. **Keep `$TMPDIR` but keep the file alive.** Have the app (which already owns a long-lived socket /
   daemon) re-run the equivalent of `ensure_node_options_restore_module()` — or simply `touch` the
   file — on an interval well under 3 days, for as long as any wrapper-launched claude is running.

There is no node-side mitigation: `--require` has no soft-fail form, and a session cannot change its
own already-exported `NODE_OPTIONS` for children it has not spawned yet without the shim.

## What we did on our side (orchestrator workaround, shipped)

- **Immediate:** recreated the file byte-for-byte from the heredoc (**:636–643**). Note that an
  empty or no-op file is *wrong*: node would preload it successfully, but every grandchild would then
  inherit `NODE_OPTIONS` — the exact thing the module exists to prevent.
- **Standing guard:** our 60 s reconciler tick (`src/reconciler/cli.ts` step 0f, #1075) reads every
  path any live process still `--require`s via `ps -Ewww -axo command=` (macOS's /proc-less
  environment read; `bin/lib/platform-unix.sh: platform::node_options_shim_refs`), `touch`es each
  one so the cleaners' 3-day idle clock never elapses, and recreates a missing one with the canonical
  bytes (`src/reconciler/node-options-shim.ts`, one copy, `cmp`-checked against the installed
  bundle's heredoc by `tests/dispatch/T143-node-options-shim-keepalive.test.ts`). An existing file
  is never overwritten, so a newer cmux writing a newer module at the same path is left alone.

## Not verified

- Which of `tmp_cleaner` / `dirhelper` removed the file on 2026-08-30, and whether `--require`
  reads refresh atime on APFS (irrelevant to the outcome: the file was removed from an active session).
- Behaviour on cmux builds other than 0.64.20; line numbers may shift.
