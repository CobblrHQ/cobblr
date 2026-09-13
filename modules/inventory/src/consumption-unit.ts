// The unit a kind's per-unit consumption is measured in.
//
// A consumable tracked unit by unit (a skein, a spool) counts in one unit and
// is used up in another: skeins on the shelf, metres off the open one. The
// metres come from the kind's `capacity` field, a computed one that reads
// the field a person fills ("Length / skein", 200 m), and the unit belongs to
// THAT field: the computed one declares none. Two readers derived it on their
// own: the detail panel took `capacity.unit` (empty) and fell back to the
// count's unit, so an opened skein was minted "in skeins", and the list then
// printed "+ 1 open · 160 skein" over 160 m of yarn (#2883, 2026-09-13).
// One rule, read by the panel that mints an open unit and by the list that
// shows what is left in it.

/** Parse a computed capacity template like "{{ length_per_skein }}" back to
 *  the single source field name it reads. Null for anything but a bare
 *  substitution (a filter or arithmetic is not the P1 direct-read shape). */
export function capacitySourceField(template: string | null | undefined): string | null {
  if (!template) return null;
  const m = template.trim().match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
  return m ? (m[1] ?? null) : null;
}

export interface UnitBearingField {
  name: string;
  type?: string | null;
  unit?: string | null;
  template?: string | null;
}

/** The consumption unit of a kind from its field defs: the capacity field's
 *  own unit, else the unit of the field its template reads, else null when
 *  the kind declares no capacity or no unit anywhere along that path. */
export function consumptionUnitOf(defs: ReadonlyArray<UnitBearingField>): string | null {
  const cap = defs.find((d) => d.name === "capacity");
  if (!cap) return null;
  if (cap.unit && cap.unit.trim()) return cap.unit.trim();
  const source = capacitySourceField(cap.template);
  const src = source ? defs.find((d) => d.name === source) : undefined;
  return src?.unit && src.unit.trim() ? src.unit.trim() : null;
}
