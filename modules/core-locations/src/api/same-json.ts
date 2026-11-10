// Two stored layouts are the same layout: compared by value, key order aside
// (a jsonb column hands keys back in its own order). An Undo reverts a place
// only while its layout is still what the change left (#9423).
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v ?? null;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
