// ── inject_id scraping (#872) ───────────────────────────────────────────────
// Moved verbatim from ./cli.ts (#1170) so the report pump can import it without
// importing the dispatch entrypoint, which runs main() on load. cli.ts re-exports it.
/**
 * The transport id telepty printed, or "" (#872).
 *
 * telepty 0.8.0 prints it on its own undecorated line so a caller can scrape it
 * without parsing the decorated success line. That is still human-facing stdout,
 * not a machine contract, so this reads conservatively: the whole line must be
 * the prefix plus the exact UUID shape crypto.randomUUID() emits, anchored at
 * both ends. Anything else yields NO id — transport.inject_id stays null and
 * dispatch-tracker.sh fires its existing no_transport_inject_id HOLD, which is
 * the honest answer. A guessed id would send the tracker to poll a DIFFERENT
 * dispatch's observation record.
 */
export function parseInjectId(text: string): string {
  const hex = "[0-9a-fA-F]";
  const re = new RegExp(
    `^[ \\t]*inject_id:[ \\t]+(${hex}{8}-${hex}{4}-${hex}{4}-${hex}{4}-${hex}{12})[ \\t]*$`,
  );
  const ids = new Set<string>();
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = re.exec(line);
    if (m) ids.add(m[1]!);
  }
  // Exactly one DISTINCT id, or none. Two different ids in one inject's output
  // is ambiguity, not a menu.
  return ids.size === 1 ? [...ids][0]! : "";
}
