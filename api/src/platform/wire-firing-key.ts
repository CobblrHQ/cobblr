// One firing, one action per target. Pure, so it is a test.
//
// fireEvent selects bindings by (org, event) alone, and a bundle that declares
// a wire at both scopes (top-level on the module's base kind, again inside its
// instance on `<instance>:item`) installs two rows that both resolve the same
// entity: checking milk off the shopping list added 2 and filed two purchases,
// and the learned re-buy rate doubled on every shop (2026-09-12). Two
// installed bundles that both restock on check-off do the same across kinds.
//
// The rule: within one firing, the same action with the same rendered args and
// template on the same entity runs once. The entity is keyed by its BASE kind,
// because `groceries:item` and `inventory:part` name one record.

export interface FiringShape {
  action_id: string;
  /** The target's base kind (an instance kind resolved to its module's). */
  target_kind: string;
  target_id: string;
  args: unknown;
  template?: string | null;
}

/** Deterministic JSON with sorted keys, so `{a,b}` and `{b,a}` are one firing. */
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

export function firingKey(f: FiringShape): string {
  return [f.action_id, f.target_kind, f.target_id, JSON.stringify(canonical(f.args ?? null)), f.template ?? ""].join(" ");
}

/** Remembers what has fired in one firing; `claim` says whether this one is new. */
export class FiringLedger {
  private readonly seen = new Set<string>();
  claim(f: FiringShape): boolean {
    const k = firingKey(f);
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}
