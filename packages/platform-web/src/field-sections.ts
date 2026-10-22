// How a kind's fields group under the headings the Form layout page saved
// (#7894). A record's panel and the New form both draw this, so the form a
// person arranged reads the same on the way in as on the way back out: the
// create form used to draw the fields flat, and Appearance appeared only on
// the saved record.

export interface SectionLike {
  id: string;
  name: string;
  position: number;
}

export interface Grouped<F, S extends SectionLike> {
  /** Fields in no section: drawn first, under no heading. */
  ungrouped: F[];
  /** Each section in its saved order with its fields; one with none is left out. */
  groups: Array<{ section: S; fields: F[] }>;
}

export function groupBySection<F extends { section_id?: string | null }, S extends SectionLike>(
  fields: readonly F[],
  sections: readonly S[] | null | undefined,
): Grouped<F, S> {
  const ordered = (sections ?? []).slice().sort((a, b) => a.position - b.position);
  // A field filed under a section this read did not bring (an older server,
  // a section deleted under it) shows with the ungrouped ones: a heading can
  // go missing, a field never does.
  const known = new Set(ordered.map((s) => s.id));
  const sectionOf = (f: F) => (f.section_id && known.has(f.section_id) ? f.section_id : null);
  return {
    ungrouped: fields.filter((f) => sectionOf(f) === null),
    groups: ordered.map((section) => ({ section, fields: fields.filter((f) => sectionOf(f) === section.id) })).filter((g) => g.fields.length > 0),
  };
}
