// Where did it actually end up?
//
// "Recently committed" answered that with the raw entity kind:
//
//   Cheese Pizza (16in)
//   -> part
//
//   OXO Silicone Pressure Cooker Set ...
//   -> inventory:part
//
// Three problems in two lines. `part` is an internal name nobody chose. The two
// rows disagree about how to spell the same destination, because some rows store
// the bare type and older ones store the full kind. And neither says which
// TABLE, which is the whole question once a workspace has Spices and Tea beside
// plain Inventory - "part" is exactly as true of a tea bag as of a bolt.

/** The routable tables a workspace has, as the instance list reports them. */
export interface DestinationTable {
  /** Instance slug: "spices", "tea", "inventory". */
  instance_name: string;
  /** What a person calls it: "Spices", "Tea", "Inventory". */
  display_name?: string | null;
  /** Owning module, for a kind that names the module rather than an instance. */
  module_name?: string | null;
  /** Domain terms the table declares for itself ("tomato", "cucumber",
   *  "skein"). The table's NAME is not always in its members' names - nothing
   *  called Cucumbers Long contains the word "grocery" - which is exactly why
   *  bundles declare these. */
  keywords?: readonly string[] | null;
}

/**
 * Both spellings of a destination, normalised.
 *
 * A stored target is either the full kind (`inventory:part`, `tea:item`) or a
 * bare type (`part`, `asset`) depending on which code path filed it. Both mean
 * the same place, and a reader should never have to know that.
 */
export function normaliseTargetKind(target: string | null | undefined, module?: string | null): string {
  const t = (target ?? "").trim();
  if (!t) return "";
  if (t.includes(":")) return t;
  // A bare type. The module it belongs to is the missing half; when the caller
  // knows it, rebuild the full kind so the two spellings converge.
  return module ? `${module}:${t}` : t;
}

/**
 * What to SHOW for a destination.
 *
 * The table's own name wins, because that is the thing the person set up and
 * the thing they will look in. Falling back to the kind is better than blank,
 * but it is a fallback and reads like one.
 */
export function destinationLabel(
  target: string | null | undefined,
  tables: readonly DestinationTable[],
  module?: string | null,
): string {
  const kind = normaliseTargetKind(target, module);
  if (!kind) return "";
  const head = kind.split(":")[0] ?? "";
  const table = tables.find((t) => t.instance_name === head);
  if (table) return (table.display_name ?? table.instance_name).trim() || table.instance_name;
  // No instance by that name: the kind names a module directly (`assets:asset`),
  // so the module half is the closest thing to a table name there is.
  const byModule = tables.find((t) => t.module_name === head && t.instance_name === head);
  if (byModule) return (byModule.display_name ?? head).trim() || head;
  return head
    .replace(/^core-/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Is this destination still the best one available?
 *
 * A scan matched days ago carries the routing of the workspace AS IT WAS. Install
 * a Tea table afterwards and every tea already in the inbox still points at plain
 * Inventory, because nothing recomputes an answer once it is stored.
 *
 * This is the cheap half of noticing: a table whose name appears in the item's
 * own words, and which is NOT where the item is headed, is a discrepancy worth
 * raising. It is deliberately conservative - one word, matched whole - because
 * the cost of a wrong nudge is a person second-guessing a correct filing.
 */
export function betterDestination(
  itemText: string,
  target: string | null | undefined,
  tables: readonly DestinationTable[],
  module?: string | null,
): DestinationTable | null {
  const words = new Set(
    itemText
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
  if (words.size === 0) return null;
  const head = normaliseTargetKind(target, module).split(":")[0] ?? "";
  const hit = (term: string): boolean => {
    const t = term.toLowerCase().trim();
    if (!t) return false;
    // A multi-word term ("tea bags") is checked against the text; a single word
    // must match a WHOLE word, so "tea" does not fire on "steamer".
    if (t.includes(" ")) return itemText.toLowerCase().includes(t);
    // Singular and plural both count: a table called "Spices" should be found
    // by an item that says "spice", and "Tea" by one that says "teas".
    //
    // The forms are ENUMERATED rather than matched by prefix. Prefix matching
    // would find "tomatoes" from "tomato" for free, and would also fire "tea"
    // on "teaspoon" - a nudge that sends somebody to re-file a measuring spoon
    // as a beverage. A short list of real plural endings costs nothing and
    // cannot do that.
    const forms = [t, t.replace(/s$/, ""), `${t}s`, `${t}es`];
    if (/[^aeiou]y$/.test(t)) forms.push(`${t.slice(0, -1)}ies`);
    return forms.some((f) => f.length > 1 && words.has(f));
  };
  for (const t of tables) {
    if (t.instance_name === head) continue;
    // The table's own name first - it is the strongest signal and the one a
    // person would give. Then the terms it declares, which is how a table gets
    // found by members that never say its name.
    const name = (t.display_name ?? t.instance_name).trim();
    if (name && hit(name)) return t;
    for (const k of t.keywords ?? []) if (hit(k)) return t;
  }
  return null;
}
