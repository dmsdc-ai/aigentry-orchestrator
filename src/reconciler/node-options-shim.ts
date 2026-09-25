// node-options-shim.ts — reconciler step 0f (#1075): keep cmux's NODE_OPTIONS restore
// shim alive for every process that still --require's it.
//
// cmux's claude wrapper (/Applications/cmux.app/Contents/Resources/bin/cmux-claude-wrapper;
// ensure_node_options_restore_module :628–657 in 0.64.20) writes
// $TMPDIR/cmux-claude-node-options/restore-node-options.cjs at claude LAUNCH and exports
// NODE_OPTIONS='--require=<that file> --max-old-space-size=4096' into the session. macOS
// purges $TMPDIR entries whose atime, mtime and ctime are all older than 3 days
// (/usr/libexec/tmp_cleaner, daily 00:00; com.apple.bsd.dirhelper
// CLEAN_FILES_OLDER_THAN_DAYS=3, daily 03:35). A session that outlives the purge keeps a
// --require pointing at nothing, and node applies --require before anything else, so EVERY
// node child of that session dies at preload (`Cannot find module …/restore-node-options.cjs`):
// stop hooks, npm test, telepty, node -p. The parent survives — it loaded the module days
// ago. Measured 2026-08-30 by causing it; the wrapper recreates the file only at launch.
//
// ONE copy of the shim's source lives here, byte-identical to the wrapper's heredoc
// (:636–643 — tests/dispatch/T143(d) cmp's it against the installed bundle). A no-op file
// would be wrong: it would leave NODE_OPTIONS set for every grandchild, which is exactly what
// the shim exists to prevent.
import * as fs from "node:fs";
import * as path from "node:path";

export const NODE_OPTIONS_SHIM_SOURCE = `const hadOriginalNodeOptions = process.env.CMUX_ORIGINAL_NODE_OPTIONS_PRESENT === "1";
if (hadOriginalNodeOptions) {
  process.env.NODE_OPTIONS = process.env.CMUX_ORIGINAL_NODE_OPTIONS ?? "";
} else {
  delete process.env.NODE_OPTIONS;
}
delete process.env.CMUX_ORIGINAL_NODE_OPTIONS;
delete process.env.CMUX_ORIGINAL_NODE_OPTIONS_PRESENT;
`;

/** The only path shape this step will ever write: the wrapper's own dir + basename. */
export const NODE_OPTIONS_SHIM_SUFFIX = "/cmux-claude-node-options/restore-node-options.cjs";

/**
 * For every path a live process still --require's (platform::node_options_shim_refs, one
 * per line): touch it, so the purge's 3-day idle clock restarts every tick; and if it is
 * already GONE, put it back with the canonical bytes and log one line. An existing file is
 * never overwritten — a newer cmux may have written a newer shim at the same path while
 * older sessions still point there. Fail-open: no refs → nothing; any other failure → one
 * ERR line, never a throw.
 */
export function keepNodeOptionsShimAlive(refs: readonly string[], log: (msg: string) => void): void {
  for (const ref of new Set(refs)) {
    // Snyk CWE-23: `ref` is read out of another process's environment (ps -E). Reviewed and
    // jailed, not silenced: only the wrapper's basename under its own directory, absolute
    // and already normalized (no `..`, no `.`), and the bytes written are a fixed constant.
    // Whoever controls that environment already controls that process; this only puts back
    // what its NODE_OPTIONS says is there.
    if (!path.isAbsolute(ref) || path.normalize(ref) !== ref || !ref.endsWith(NODE_OPTIONS_SHIM_SUFFIX)) continue;
    const now = new Date();
    try {
      fs.utimesSync(ref, now, now);
      continue;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log(`ERR node-options-shim touch ${ref}: ${code ?? String(e)} (continuing)`);
        continue;
      }
    }
    try {
      // The wrapper's own idiom (:631–656): mkdir -p, write a sibling temp, chmod 0644, mv -f.
      fs.mkdirSync(path.dirname(ref), { recursive: true });
      const tmp = `${ref}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, NODE_OPTIONS_SHIM_SOURCE);
      fs.chmodSync(tmp, 0o644);
      fs.renameSync(tmp, ref);
      log(
        `NODE_OPTIONS_SHIM recreated ${ref} — a live process still --require's it and the file was gone (macOS purges idle $TMPDIR entries after 3 days; #1075)`,
      );
    } catch (e) {
      log(`ERR node-options-shim recreate ${ref}: ${(e as NodeJS.ErrnoException).code ?? String(e)} (continuing)`);
    }
  }
}
