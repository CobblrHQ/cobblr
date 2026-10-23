/** What a line's quantity text says: "3", "1.5", "1,5 kg", "2 boxes". The
 *  number keeps its decimal and the words after it are the unit, so a measured
 *  line is read the way it was written (#7867). Null when it does not start
 *  with a number ("a few"). */
export function parseLineAmount(qty: string | null | undefined): { value: number; unit: string | null } | null {
  const m = /^\s*[×x]?\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(.*?)\s*$/i.exec(qty ?? "");
  if (!m) return null;
  const value = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: m[2] ? m[2] : null };
}

/** The text a corrected amount is saved as: the person's own unit kept. */
export function lineAmountText(value: number, unit: string | null): string {
  return unit ? `${value} ${unit}` : String(value); // count-unit-ok: the unit is the person's own word, kept as written
}
