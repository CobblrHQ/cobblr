// How a workspace arranges the panels on one kind of record (#6337): which
// it hides and the order the rest stand in. The owner, on his 3D printer:
// "uncontrolled growth". Which panels APPLY is the panel's own declaration
// (its collections and presence, panel-shows.ts); this is the person's say
// over the ones that apply. Keyed by the record's collection kind when it has
// one ("3d-printers:item"), else its kind, so a printer and a kiln, both
// machines, are arranged apart. No zod here: the browser loads this.

export interface RecordPanelChoice {
  hidden?: boolean;
  /** Lower stands higher. A panel with no order keeps its declared place,
   *  after every panel that has one. */
  order?: number;
}

export interface RecordPanelLayout {
  panels: Record<string, RecordPanelChoice>;
}

export const EMPTY_RECORD_PANEL_LAYOUT: RecordPanelLayout = { panels: {} };

/** The panels a record shows, in the order it shows them: hidden ones out,
 *  ordered ones first by their order, the rest after in declared order. */
export function arrangePanels<P extends { id: string }>(panels: readonly P[], layout: RecordPanelLayout | null | undefined): P[] {
  const choice = layout?.panels ?? {};
  return panels
    .map((p, i) => ({ p, i, c: choice[p.id] }))
    .filter((x) => !x.c?.hidden)
    .sort((a, b) => {
      const ao = a.c?.order, bo = b.c?.order;
      if (ao !== undefined && bo !== undefined) return ao - bo || a.i - b.i;
      if (ao !== undefined) return -1;
      if (bo !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.p);
}

/** The key a record's panels are arranged under: its collection's kind when
 *  it is filed in one, else its own kind. */
export function panelLayoutKey(kind: string, collection: string | null | undefined): string {
  return collection && collection.includes(":") ? collection : kind;
}
