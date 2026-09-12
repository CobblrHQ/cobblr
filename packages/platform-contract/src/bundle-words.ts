// A bundle's table routes on BOTH vocabularies, deduped: the table's own words
// and the manifest's. One rule for the two readers that had drifted: the
// per-scan offer for a bundle not yet installed merged them (2026-08-19), the
// install wrote only the table's own, and an installed Groceries knew 40
// words while the offer knew 150. The dashboard's sample cola then filed
// into plain Inventory in a sandbox whose Groceries declared "cola" one level
// up (2026-09-12). The table's words come first so a table-specific term wins
// any first-match read. Pure.
export function bundleTableWords(
  tableWords: readonly unknown[] | null | undefined,
  manifestWords: readonly unknown[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(tableWords ?? []), ...(manifestWords ?? [])]) {
    if (typeof raw !== "string") continue;
    const k = raw.trim();
    const key = k.toLowerCase();
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}
