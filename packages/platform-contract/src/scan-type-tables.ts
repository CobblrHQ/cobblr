// A table that another table names as its `parent` holds the DEFINITIONS of
// a thing (a filament type: Royal Blue PLA), and its child holds the things
// themselves (the spools). A scan is always of a physical thing, so it lands
// in the child, and the child's auto-lift finds or makes the type. The type
// table is never where a scan files, and the child routes on the words its
// type defines as well as its own, since a spool is described by its type's
// material and diameter far more than by its batch code (#3930).
//
// One rule for the two menus a scan reads: the live tables of a workspace and
// the tables of a bundle offered to install on add. Pure.

export interface ParentedTable {
  instance: string;
  /** The instance's `parent` config, as a bundle or the instance declares it. */
  parent?: { instance?: unknown } | null;
}

/** The tables some sibling names as its parent. */
export function typeTablesAmong(tables: readonly ParentedTable[]): Set<string> {
  const out = new Set<string>();
  for (const t of tables) {
    const p = t.parent?.instance;
    if (typeof p === "string" && p.trim() && p !== t.instance) out.add(p);
  }
  return out;
}

/** The instance a table's parent config names, or null. */
export function parentInstanceOf(t: ParentedTable): string | null {
  const p = t.parent?.instance;
  return typeof p === "string" && p.trim() && p !== t.instance ? p : null;
}

/** What a scan calls the child table: the group both tables sit under
 *  ("Filament") when there is one, since the child's own name ("Spools")
 *  reads as half a thing on its own; else its own name. */
export function scanLabelForChild(displayName: string, navGroupLabel: unknown): string {
  return typeof navGroupLabel === "string" && navGroupLabel.trim() ? navGroupLabel.trim() : displayName;
}

/** The child's fields followed by any of its type's it does not declare. */
export function withTypeFields<F extends { name: string }>(own: readonly F[], ofType: readonly F[]): F[] {
  const seen = new Set(own.map((f) => f.name));
  return [...own, ...ofType.filter((f) => !seen.has(f.name))];
}
