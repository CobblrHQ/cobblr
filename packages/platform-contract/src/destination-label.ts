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

// The better-table question ("does a table the workspace has now claim this
// item better than where it is headed?") is the resolver's, answered by the
// router's one rule: scanBetterTable in scan-triage.ts, over table-fit.ts.
// A one-whole-word rule used to live here beside it, with no plausibility
// floor and no category, and every product whose brand is a fruit was
// offered Groceries (#3136).
