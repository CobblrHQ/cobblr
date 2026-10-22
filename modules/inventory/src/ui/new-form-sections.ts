// The order a New form draws an instance's own fields in (#7894): the ones in
// no section first, then each Form layout section's fields, the first of them
// carrying the section's heading. The saved record already draws this; the
// create form drew the fields flat, so "Appearance" showed above Finish on the
// record and nowhere on the form that made it.
import { groupBySection } from "@cobblr/platform-web";

export interface FormRow<F> {
  f: F;
  /** Set on the first field of a section: the heading to draw above it. */
  heading?: { id: string; name: string };
}

export function customFieldRows<F extends { name: string; section_id?: string | null }>(
  fields: readonly F[],
  sections: ReadonlyArray<{ id: string; name: string; position: number }> | undefined,
  /** The field a scanner row draws itself; left out before grouping so it never strands a heading. */
  drawnElsewhere?: string | null,
): FormRow<F>[] {
  const { ungrouped, groups } = groupBySection(fields.filter((f) => f.name !== drawnElsewhere), sections);
  return [
    ...ungrouped.map((f): FormRow<F> => ({ f })),
    ...groups.flatMap(({ section, fields: inSection }) =>
      inSection.map((f, i): FormRow<F> => (i === 0 ? { f, heading: { id: section.id, name: section.name } } : { f })),
    ),
  ];
}
