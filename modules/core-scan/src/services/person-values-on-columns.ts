// A person's value for one of the kind's own columns is written to that
// column, not into the record's metadata (#9576).
//
// Everything a filing carries rides in `metadata`, and a native column reads
// only its own key: an asset's Paid that Cobb was told came to rest as
// metadata.purchase_price_cents, and the Paid column stayed empty. The value
// was kept and nobody could see it.
//
// Only what a person gave (stamped person, or typed on the form), only for a
// column the kind declares and a caller may write, only when nothing already
// sets that column at the top level (what the caller sent wins), and only a
// value of the column's own type: anything else stays in metadata, as it
// always did, rather than failing the create. Pure.

export interface NativeColumn {
  name: string;
  type?: string | null;
  readOnly?: boolean | null;
}

const NEVER = new Set(["image-path", "object", "computed", "ref", "location-ref"]);

function fits(type: string | null | undefined, v: unknown): boolean {
  const t = (type ?? "text").toLowerCase();
  if (t === "number" || t === "integer" || t === "currency" || t === "money") return typeof v === "number" && Number.isFinite(v);
  if (t === "boolean") return typeof v === "boolean";
  if (t === "date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  return typeof v === "string" && v.trim() !== "";
}

/** The keys of `metadata` that move to the top of `body`: the person's
 *  (`personKeys`) that name a writable native column (`columns`, the kind's
 *  own fields minus the workspace's custom ones), are not set at the top
 *  already, and hold a value of the column's type. */
export function personValuesOnColumns(
  body: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>>,
  personKeys: Iterable<string>,
  columns: readonly NativeColumn[],
): Record<string, unknown> {
  const byName = new Map(columns.filter((c) => !c.readOnly && !NEVER.has(String(c.type ?? ""))).map((c) => [c.name, c]));
  const out: Record<string, unknown> = {};
  for (const k of personKeys) {
    const col = byName.get(k);
    if (!col || k === "metadata" || body[k] !== undefined || !(k in metadata)) continue;
    if (fits(col.type, metadata[k])) out[k] = metadata[k];
  }
  return out;
}
