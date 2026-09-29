// Rows that landed in a module's default table but look like they belong in one
// of its named tables - and the offer to move them.
//
// The Kitchen cluster made this concrete: groceries lived as rows-with-food-
// fields in plain Inventory before the Groceries table existed. Making the
// table did not move anything (an update never opts you in, and neither does
// it relocate your data), so a workspace can sit with a populated Inventory
// and an empty Groceries forever unless something OFFERS the move.
//
// The signal is deliberately dumb and generic: a default-table row that carries
// a VALUE for a custom field some named table defines looks like it belongs
// there. No bundle names, no food words - a row with `caffeine` filled looks
// like Tea because Tea is the table that defines `caffeine`. New bundles get
// the offer for free by declaring fields, which is the same contract the scan
// matchmaker already runs on.
//
// Only CUSTOM field values count, never a record's own columns. Spools define
// a custom field `state`, and every inventory row has a built-in `state`
// column with a value; read together, every soap and screw "looked like" a
// spool and the dashboard offered to move them all into Spools. A row is
// built with offerRowFrom, which takes the custom bag alone.

export interface OfferRow {
  id: string;
  /** The row's CUSTOM field values (its metadata). Never its own columns: a
   *  built-in column that shares a custom field's name is not that field. */
  custom: Record<string, unknown>;
  name?: string | null;
}

/** An offer row from a record as the items list returns it. */
export function offerRowFrom(r: { id: string; name?: string | null; metadata?: Record<string, unknown> | null }): OfferRow {
  return { id: r.id, name: r.name ?? null, custom: r.metadata ?? {} };
}

export interface OfferTable {
  instance_name: string;
  display_name?: string | null;
  module_name?: string | null;
}

export interface MoveOffer {
  instance: string;
  label: string;
  ids: string[];
  names: string[];
}

const hasValue = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Which rows look like they belong in which named table.
 *
 * A row that matches ONE table is offered for it. A row matching several is
 * left alone - ambiguity never auto-resolves, and a wrong offer teaches people
 * to dismiss the card (the same rule the scan autofile holds).
 */
export function offerMoves(
  rows: readonly OfferRow[],
  tables: readonly OfferTable[],
  fieldDefs: readonly { entity_kind: string; name: string }[],
  moduleName: string,
): MoveOffer[] {
  // Choosing which named tables can RECEIVE a move - not narrowing what a
  // user sees; every row stays listed where it is.
  // registry-filter-ok: move destinations, not a listing
  const named = tables.filter(
    (t) => t.module_name === moduleName && t.instance_name !== moduleName,
  );
  if (named.length === 0) return [];
  const defsByInstance = new Map<string, Set<string>>();
  for (const t of named) {
    const kind = `${t.instance_name}:item`;
    defsByInstance.set(
      t.instance_name,
      new Set(fieldDefs.filter((d) => d.entity_kind === kind).map((d) => d.name)),
    );
  }

  const offers = new Map<string, MoveOffer>();
  for (const row of rows) {
    let best: { instance: string; hits: number } | null = null;
    let tied = false;
    for (const t of named) {
      const defs = defsByInstance.get(t.instance_name)!;
      if (defs.size === 0) continue;
      let hits = 0;
      for (const name of defs) if (hasValue(row.custom[name])) hits++;
      if (hits === 0) continue;
      if (!best || hits > best.hits) {
        best = { instance: t.instance_name, hits };
        tied = false;
      } else if (hits === best.hits) {
        tied = true;
      }
    }
    if (!best || tied) continue;
    const t = named.find((x) => x.instance_name === best!.instance)!;
    const cur =
      offers.get(best.instance) ??
      ({ instance: best.instance, label: t.display_name ?? t.instance_name, ids: [], names: [] } as MoveOffer);
    cur.ids.push(row.id);
    cur.names.push(row.name ?? "one item");
    offers.set(best.instance, cur);
  }
  return [...offers.values()].sort((a, b) => b.ids.length - a.ids.length);
}
