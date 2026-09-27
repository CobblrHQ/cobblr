// A lot read off a label lands in whichever field carries the `lot` role.
//
// Yarn calls it Dye lot, a pantry calls it Lot number, a filament shelf calls
// it Batch: behaviour follows the declared role, never the field's name, so
// the same reading fills all three. The lot is kept on the row as `lot`
// (label-quantity.ts) because it is often read after the row was routed (the
// scan photo's label is read in the background); filing then puts it where
// the destination says a lot goes.
//
// Per unit, never per product: nothing here, and nothing that reads `lot`,
// sends it to the shared barcode network (barcode-corrections.ts drops it
// from label words).

/** The destination field that carries the lot, or null. */
export function lotFieldOf(fields: ReadonlyArray<{ name: string; field_role?: string | null }>): string | null {
  return fields.find((f) => f.field_role === "lot")?.name ?? null;
}

/** The patch that files a row's label lot into the destination's lot field.
 *  Empty when there is no lot, or no field for it. The caller spreads it
 *  below the person's own values, so a typed lot always wins. */
export function lotPatchFor(meta: unknown, fields: ReadonlyArray<{ name: string; field_role?: string | null }>): Record<string, string> {
  const lot = (meta as { lot?: unknown } | null)?.lot;
  if (typeof lot !== "string" || !lot.trim()) return {};
  const field = lotFieldOf(fields);
  return field ? { [field]: lot.trim() } : {};
}
