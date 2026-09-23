// Which tables get the platform's scan category axis, and which lose the one
// they were given by mistake. Pure, so the rule is testable without a database.
//
// The axis exists to tell apart the MANY kinds of thing that land in a generic
// catch-all (a plain Inventory). A specialised table is already one kind of
// thing: a Yarn table made the scan fallback by the Yarn app grew a "Category"
// column filled with catalog paths ("Home & Garden > Kitchen & Dining") and a
// "File all as ..." button for them (2026-09-02). So only a module's DEFAULT
// instance gets the placeholder, and a placeholder that landed on a named
// instance is withdrawn.

export interface AxisInstance {
  org_id: string;
  module_name: string;
  instance_name: string;
  is_default: boolean;
  is_scan_fallback: boolean;
}
export interface AxisFieldDef {
  org_id: string;
  entity_kind: string;
  name: string;
  field_role: string | null;
  source_module: string | null;
  /** What the field reads as on a form; the placeholder's default is the
   *  axis's own word, and a person may have renamed it. */
  display_label?: string | null;
}
export interface AxisPlan {
  /** Create the platform placeholder on this kind, with these words. */
  add: Array<{ org_id: string; kind: string; label: string; help: string }>;
  /** A bundle's own `category` field exists on this kind: adopt it as the axis. */
  adopt: Array<{ org_id: string; kind: string }>;
  /** A platform placeholder sits on a specialised table: withdraw it. */
  remove: Array<{ org_id: string; kind: string }>;
  /** A placeholder on a kind whose module keeps its own categories: its
   *  values move into that taxonomy and then it goes (#3223). One question,
   *  one storage, and the form stops asking "Category" twice. */
  retire: Array<{ org_id: string; kind: string }>;
}

/** The words the platform's category axis wears on a form. Only a kind with
 *  no categories of its own gets the platform's axis at all (a kind that keeps
 *  its own answers from its taxonomy, #3223), so there is one wording. */
export function axisWords(): { label: string; help: string } {
  return {
    label: "Category",
    help: "What KIND of thing this is. Scans group by it, and a category that outgrows this table can be promoted into its own.",
  };
}

export function planScanCategoryAxes(
  instances: AxisInstance[],
  existing: AxisFieldDef[],
  moduleKind: Map<string, string>,
  categoryField: string,
  placeholderSource: string,
  /** The kinds whose module keeps its own category records (they declare
   *  `categoryAxis`): the taxonomy is their axis, so they never get the
   *  placeholder, and one they were given is retired. */
  ownCategoryKinds: ReadonlySet<string> = new Set(),
): AxisPlan {
  const hasRole = new Set(existing.filter((f) => f.field_role === "category").map((f) => `${f.org_id}::${f.entity_kind}`));
  const named = new Set(existing.filter((f) => f.name === categoryField).map((f) => `${f.org_id}::${f.entity_kind}`));
  const plan: AxisPlan = { add: [], adopt: [], remove: [], retire: [] };

  // The fallback per (org, module): the pick, else the module's default.
  const fallback = new Map<string, AxisInstance>();
  for (const inst of instances) {
    const key = `${inst.org_id}::${inst.module_name}`;
    const cur = fallback.get(key);
    if (inst.is_scan_fallback) fallback.set(key, inst);
    else if (!cur && inst.is_default) fallback.set(key, inst);
  }
  for (const inst of fallback.values()) {
    const kind = moduleKind.get(inst.module_name);
    if (!kind || !inst.is_default) continue;
    // A kind that keeps its own taxonomy answers from it: no placeholder, and
    // no adopting a bundle's plain `category` field into a second axis either.
    if (ownCategoryKinds.has(kind)) continue;
    const kindKey = `${inst.org_id}::${kind}`;
    if (hasRole.has(kindKey)) continue;
    if (named.has(kindKey)) plan.adopt.push({ org_id: inst.org_id, kind });
    else plan.add.push({ org_id: inst.org_id, kind, ...axisWords() });
  }
  // Withdraw the placeholder from every kind that is not a module's default kind.
  const defaultKinds = new Set(moduleKind.values());
  for (const f of existing) {
    if (f.source_module !== placeholderSource || f.name !== categoryField) continue;
    if (!defaultKinds.has(f.entity_kind)) {
      plan.remove.push({ org_id: f.org_id, kind: f.entity_kind });
      continue;
    }
    // The platform's placeholder on a kind that keeps its own taxonomy is
    // retired whatever it is called: a rename was a person telling apart two
    // questions this change makes one, and their values move, not their label.
    if (ownCategoryKinds.has(f.entity_kind)) plan.retire.push({ org_id: f.org_id, kind: f.entity_kind });
  }
  return plan;
}
