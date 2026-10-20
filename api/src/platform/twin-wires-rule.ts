// The rule behind heal-twin-bundle-wires.ts, kept apart from it so it can be
// tested without the api environment (importing meta exits without a DATABASE_URL).

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

export function canonicalArgs(args: unknown): string {
  return JSON.stringify(canonical(args ?? null));
}

/** Which rows of one (org, bundle, event, action, args) group are twins to
 *  drop: every row whose kind is the BASE kind of another row's instance kind,
 *  plus exact duplicates beyond the first. Pure, so it is a test. */
export function twinsToDrop(group: Array<{ id: string; source_kind: string; created_at: Date }>, baseOf: (kind: string) => string): string[] {
  const drop = new Set<string>();
  const instanceBases = new Set(group.filter((r) => baseOf(r.source_kind) !== r.source_kind).map((r) => baseOf(r.source_kind)));
  for (const r of group) if (instanceBases.has(r.source_kind)) drop.add(r.id);
  const seen = new Set<string>();
  for (const r of [...group].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
    if (drop.has(r.id)) continue;
    if (seen.has(r.source_kind)) drop.add(r.id);
    seen.add(r.source_kind);
  }
  return [...drop];
}
