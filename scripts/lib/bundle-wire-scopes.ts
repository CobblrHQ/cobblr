// A wire declared at both scopes of one bundle fires twice.
//
// A bundle can wire an event at the top level (on the module's base kind) and
// again inside a `provides_instances[]` entry (on `<instance>:item`). The wire
// engine selects bindings by (org, event) and resolves both to the same record,
// so one check-off restocked twice and filed two purchases (2026-09-12). The
// instance scope is the one that applies to a bundle's items; the top-level
// twin is a duplicate, never a second behaviour. Pure, so it is a test and a
// lint (scripts/lint-bundle-content.ts).

export interface WireDecl {
  trigger_event?: string | null;
  trigger_schedule?: string | null;
  action_id: string;
}

export interface ManifestLike {
  id?: string;
  wires?: WireDecl[];
  provides_instances?: Array<{ instance_name: string; wires?: WireDecl[] }>;
}

function trigger(w: WireDecl): string {
  return w.trigger_event ? `event ${w.trigger_event}` : `schedule ${w.trigger_schedule ?? ""}`;
}

/** Every (trigger, action) a bundle declares at BOTH the top level and inside
 *  an instance, phrased for a person. Empty when the bundle is clean. */
export function twinScopeWires(m: ManifestLike): string[] {
  const top = new Map<string, WireDecl>();
  for (const w of m.wires ?? []) top.set(`${trigger(w)} -> ${w.action_id}`, w);
  const out: string[] = [];
  for (const inst of m.provides_instances ?? []) {
    for (const w of inst.wires ?? []) {
      const key = `${trigger(w)} -> ${w.action_id}`;
      if (top.has(key)) out.push(`${key} is declared top-level AND in instance "${inst.instance_name}"`);
    }
  }
  return out;
}
