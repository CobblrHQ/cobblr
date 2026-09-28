// The number a stat block shows, computed in one place.
//
// The App Player and the public page each summed a view's rows themselves,
// and they had already drifted: one read a custom field from the row's
// metadata and the other did not, so a public page and the member's own app
// could show two totals for one view. `times` multiplies each row before it
// is summed, so a cellar's value is price x bottles, not the sum of labels.

export interface StatSpec {
  agg: "count" | "sum";
  /** The field summed, for `sum`. */
  field?: string | undefined;
  /** A field each row's value is multiplied by before summing (a count). */
  times?: string | undefined;
}

type Row = { fields?: Record<string, unknown> | null };

/** A row's value for a field: the field itself, else the same key in its
 *  metadata (a custom field on a record that nests them). */
function fieldOf(row: Row, name: string): number {
  const fields = row.fields ?? {};
  const meta = (fields.metadata && typeof fields.metadata === "object" ? fields.metadata : {}) as Record<string, unknown>;
  const raw = fields[name] ?? meta[name];
  if (raw === null || raw === undefined || raw === "") return NaN;
  return typeof raw === "number" ? raw : Number(raw);
}

/** The stat over these rows. A row whose value (or multiplier) is not a
 *  number adds nothing, rather than making the total NaN. */
export function statValue(rows: readonly Row[], spec: StatSpec): number {
  if (spec.agg === "count" || !spec.field) return rows.length;
  let total = 0;
  for (const r of rows) {
    const v = fieldOf(r, spec.field);
    const m = spec.times ? fieldOf(r, spec.times) : 1;
    if (Number.isFinite(v) && Number.isFinite(m)) total += v * m;
  }
  return Math.round(total * 100) / 100;
}

/** The key a precomputed stat is stored under: one view can carry several. */
export function statKey(viewId: string, spec: StatSpec): string {
  if (spec.agg !== "sum" || !spec.field) return viewId;
  return spec.times ? `${viewId}:${spec.field}*${spec.times}` : `${viewId}:${spec.field}`;
}
