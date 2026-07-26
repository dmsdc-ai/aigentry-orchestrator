// ADR §4.8.2 — crash recovery.
// On startup, scan ~/.aigentry/sessions/**/*.tmp.* and unlink (incomplete writes).
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";

export interface RecoveryReport {
  scanned: number;
  deleted: string[];
  errors: Array<{ path: string; error: string }>;
}

const TMP_PATTERN = /\.tmp\./;

export async function sweepIncompleteWrites(
  sessionsRoot: string,
): Promise<RecoveryReport> {
  const report: RecoveryReport = { scanned: 0, deleted: [], errors: [] };
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sessionsRoot, { recursive: true, withFileTypes: true });
  } catch (err) {
    // Missing root = nothing to sweep. Any other read failure aborts the whole
    // walk (recursive readdir is all-or-nothing, unlike the per-dir descent it
    // replaced) and is reported rather than thrown.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      report.errors.push({ path: sessionsRoot, error: (err as Error).message });
    }
    return report;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    report.scanned++;
    if (!TMP_PATTERN.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    try {
      await fs.unlink(full);
      report.deleted.push(full);
    } catch (err) {
      report.errors.push({ path: full, error: (err as Error).message });
    }
  }
  return report;
}
