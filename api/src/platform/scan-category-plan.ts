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
  /** A placeholder on a kind that keeps its own categories still wears the
   *  bare word: give it scanning's, so a form does not ask twice. */
  relabel: Array<{ org_id: string; kind: string; label: string; help: string }>;
}

/** The words the platform's category axis wears on a form. On a kind whose
 *  module keeps its own categories (inventory's tree, with a filter in the
 *  list), the axis is a second question with the same name, so it says whose
 *  it is; the two are joined into one axis later, and this wording goes then. */
export function axisWords(ownCategories: boolean): { label: string; help: string } {
  return ownCategories
    ? {
        label: "Scan category",
        help: "What kind of thing a scan read this as; scans are grouped by it. Separate from this table's own categories, which the list filters by.",
      }
    : {
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
  /** The kinds whose module keeps its own category records. */
  ownCategoryKinds: ReadonlySet<string> = new Set(),
): AxisPlan {
  const hasRole = new Set(existing.filter((f) => f.field_role === "category").map((f) => `${f.org_id}::${f.entity_kind}`));
  const named = new Set(existing.filter((f) => f.name === categoryField).map((f) => `${f.org_id}::${f.entity_kind}`));
  const plan: AxisPlan = { add: [], adopt: [], remove: [], relabel: [] };

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
    const kindKey = `${inst.org_id}::${kind}`;
    if (hasRole.has(kindKey)) continue;
    if (named.has(kindKey)) plan.adopt.push({ org_id: inst.org_id, kind });
    else plan.add.push({ org_id: inst.org_id, kind, ...axisWords(ownCategoryKinds.has(kind)) });
  }
  // Withdraw the placeholder from every kind that is not a module's default kind.
  const defaultKinds = new Set(moduleKind.values());
  for (const f of existing) {
    if (f.source_module !== placeholderSource || f.name !== categoryField) continue;
    if (!defaultKinds.has(f.entity_kind)) {
      plan.remove.push({ org_id: f.org_id, kind: f.entity_kind });
      continue;
    }
    // Only a placeholder still wearing the bare word is relabelled: a person
    // who renamed it keeps their name.
    if (ownCategoryKinds.has(f.entity_kind) && (f.display_label ?? "Category") === "Category") {
      plan.relabel.push({ org_id: f.org_id, kind: f.entity_kind, ...axisWords(true) });
    }
  }
  return plan;
}
