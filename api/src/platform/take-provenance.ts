// What a sandbox's take leaves out: the examples it came with, and nothing the
// person made. Pure (rows in, rows out) so the rule is tested without a
// database (api/tests/a-row-the-platform-wrote-about-an-example-never-makes-
// it-the-persons.test.ts); buildBackupZip in routes/backup.ts is the caller.

/** Take a sandbox's stock out of the dump. Stock is every row made at or
 *  before the hand-over (its `created_at`), plus the records the log names
 *  as made then (`omit`, for a table with no timestamp). A stock row that
 *  points at stock being left out goes with it (a sample book's lot, its
 *  stock moves); stock that the person's own rows point at stays (their
 *  grocery on the example list keeps the list). Returns the ids left out.
 *
 *  Whose a row is comes from who made it, never from being newer than the
 *  line: the platform writes after the hand-over too (a sweep, a wire, a
 *  label code minted on first view), and a row it wrote about an example
 *  would otherwise make that example the person's (#4364). So a row written
 *  after the hand-over is the person's only if it is something they made
 *  (`madeBy`, from the log), names something they made, or names no example
 *  at all. One that names only examples goes with them. */
export function leaveOut<T extends { row_count: number }>(
  dataFiles: Array<{ lines: string[]; index: T }>,
  opts: { omit?: ReadonlySet<string>; stockUntil?: Date; madeBy?: ReadonlySet<string> },
): Set<string> {
  type Row = { line: string; id: string | null; own: boolean; out: boolean };
  const until = opts.stockUntil?.getTime();
  const madeBy = opts.madeBy ?? new Set<string>();
  const tables: Row[][] = dataFiles.map((d) =>
    d.lines.map((line) => {
      const r = JSON.parse(line) as { id?: unknown; created_at?: unknown };
      const id = r.id == null ? null : String(r.id);
      const made = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
      const stock = (id !== null && !!opts.omit?.has(id)) || (until !== undefined && Number.isFinite(made) && made <= until);
      return { line, id, own: !stock && until !== undefined && Number.isFinite(made) && made > until, out: stock };
    }),
  );
  const all = tables.flat();
  const stockIds = all.filter((r) => r.out && r.id).map((r) => r.id!);
  for (const r of all) {
    if (!r.own || (r.id !== null && madeBy.has(r.id))) continue;
    if ([...madeBy].some((id) => r.line.includes(id))) continue;
    if (stockIds.some((id) => r.line.includes(id))) {
      r.own = false;
      r.out = true;
    }
  }
  // An example the person's own rows point at stays, and stays for good: it
  // is never sent back out by another example it names, nor by its own id.
  const kept = new Set<Row>();
  for (let round = 0; round < 6; round++) {
    let changed = false;
    const ownText = all.filter((r) => r.own).map((r) => r.line).join("\n");
    for (const r of all) {
      if (r.out && r.id && ownText.includes(r.id)) {
        r.out = false;
        kept.add(r);
        changed = true;
      }
    }
    const outIds = new Set(all.filter((r) => r.out && r.id).map((r) => r.id!));
    for (const r of all) {
      if (r.out || r.own || kept.has(r)) continue;
      for (const id of outIds) {
        if (id !== r.id && r.line.includes(id)) {
          r.out = true;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  dataFiles.forEach((d, i) => {
    const keep = tables[i]!.filter((r) => !r.out).map((r) => r.line);
    d.lines = keep;
    d.index = { ...d.index, row_count: keep.length };
  });
  return new Set(all.filter((r) => r.out && r.id).map((r) => r.id!));
}
