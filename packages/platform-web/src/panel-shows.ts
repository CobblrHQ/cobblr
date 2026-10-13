// Whether one contributed record panel shows on one record (#6337). Pure and
// free of React, so the record page (ContributedDetailPanels) and the
// per-kind panel census (scripts/every-record-shows-only-the-panels-it-declares.test.ts)
// decide by the same rule.

/** The fields of a contributed panel this rule reads. */
export interface PanelRule {
  id: string;
  appliesTo?: { traits?: string[] } | { any: true } | null;
  collections?: string[] | null;
  presence?: boolean | null;
  face?: string | null;
  placement?: "summary" | "details";
}

/** What decides whether one contributed panel shows on one record. Pure, so
 *  the host and the per-kind panel census (#6337) agree by construction. */
export interface PanelRecordShape {
  /** The record's collection, by its stable name ("3d-printers"), or null for
   *  a record in its module's own default collection. */
  collection: string | null;
  /** The trait values its collection wears ("*" = all). */
  worn: ReadonlySet<string>;
  /** The faces a person has on; a hidden face hides its panels. */
  facesOn: ReadonlySet<string>;
  /** The presence-declared panels that have data on this record. */
  present: ReadonlySet<string>;
}

/** A panel that names its collections or its presence is explicit: it shows
 *  only in those collections, or where its data already is. One that names
 *  neither keeps the old rule, its target and traits alone (a tag or a
 *  discussion is about any record). */
export function panelShows(p: PanelRule, r: PanelRecordShape, placement?: "summary" | "details"): boolean {
  const explicit = !!p.collections?.length || !!p.presence;
  if (explicit) {
    const inCollection = !!r.collection && !!p.collections?.includes(r.collection);
    const hasData = !!p.presence && r.present.has(p.id);
    if (!inCollection && !hasData) return false;
  }
  const traits = p.appliesTo && "traits" in p.appliesTo ? p.appliesTo.traits : undefined;
  const eligible = !traits?.length || r.worn.has("*") || traits.every((t) => r.worn.has(t));
  const shown = !p.face || r.facesOn.has(p.face);
  return eligible && shown && (!placement || (p.placement ?? "details") === placement);
}

/** "3d-printers:item" is the collection "3d-printers". */
export function collectionNameOf(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const name = hint.endsWith(":item") ? hint.slice(0, -":item".length) : hint;
  return name || null;
}

