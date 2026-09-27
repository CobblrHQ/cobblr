// The capture drawer's one line for an item: what it is, the colourway when
// the name does not already say it, the lot, and how many (#3731): "Charisma
// Yarn, Dark Blue · lot 6127 · ×3". Everything here is the row's own fields,
// read from the label or typed by the person.

export function capturedLine(name: string, item: { quantity?: number | null; suggested_candidates?: unknown; suggested_metadata?: unknown }): string {
  const cands = Array.isArray(item.suggested_candidates) ? (item.suggested_candidates as Array<{ fields?: Record<string, unknown> }>) : [];
  const fields = cands[0]?.fields ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const colourway = str(fields.colorway) ?? str(fields.colourway);
  // "J7 Dark Blue" beside "Charisma Yarn Dark Blue" says nothing new.
  const said = (v: string) => name.toLowerCase().includes(v.replace(/^[A-Z]?\d+\s+/i, "").toLowerCase());
  const head = colourway && !said(colourway) ? `${name}, ${colourway}` : name;
  // The lot read off the label is the row's own fact (`lot`), whichever field
  // of the destination will carry it; a value already on the route shows too.
  const lot = str((item.suggested_metadata as { lot?: unknown } | null | undefined)?.lot) ?? str(fields.dye_lot) ?? str(fields.lot);
  const qty = typeof item.quantity === "number" && item.quantity > 1 ? `×${item.quantity}` : null;
  return [head, lot ? `lot ${lot}` : null, qty].filter(Boolean).join(" · ");
}
