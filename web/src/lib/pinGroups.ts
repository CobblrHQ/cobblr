// Grouping the things pinned on a plan by one of their fields (#4564).
//
// A drawer of sockets reads by drive: everything 3/8 in together, the 1/4 in
// ones together. Which fields a plan can group by is read from the things
// pinned on it, never named here: any measure (Size, Drive) or field with
// choices (Type) their kinds declare, so a drawer of yarn groups by weight and
// a bin of bolts by thread the same way. The choice is remembered on the plan.
//
// Pure, so the grouping is asserted without a browser.
import { asMeasure, formatMeasure } from "@cobblr/platform-contract/measure";

export interface GroupField {
  name: string;
  label: string;
  type: string;
  unit?: string | null;
  position?: number;
}

/** The fields worth grouping by: measures and fields with choices, once each. */
export function groupableFields(defs: ReadonlyArray<{ name: string; display_label?: string | null; type: string; unit?: string | null; choices?: readonly string[] | null; position?: number }>): GroupField[] {
  const out = new Map<string, GroupField>();
  for (const d of defs) {
    if (out.has(d.name)) continue;
    if (d.type === "measure" || (d.type === "text" && d.choices?.length)) {
      out.set(d.name, { name: d.name, label: d.display_label || d.name, type: d.type, unit: d.unit ?? null, position: d.position ?? 0 });
    }
  }
  return [...out.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** A record's value for one of its custom fields (the only ones a plan
 *  offers to group by), never a built-in column of the same name. */
export function fieldValue(fields: Record<string, unknown> | null | undefined, name: string): unknown {
  const meta = fields?.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>)[name] : undefined;
}

/** The value as a person reads it, or null when the record holds none. */
export function valueText(v: unknown, field: GroupField): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (field.type === "measure") {
    const m = asMeasure(v, field.unit ?? null);
    return m ? formatMeasure(m) : String(v);
  }
  return typeof v === "string" ? v.trim() || null : String(v);
}

export interface PinGroup {
  /** What the group's things share, or null for "no <field>". */
  value: string | null;
  label: string;
  keys: string[];
}

/** The pins in groups: smallest measure first (or A to Z), the ones without a
 *  value last, under "no <field>". */
export function groupPins(pins: ReadonlyArray<{ key: string; fields: Record<string, unknown> | null | undefined }>, field: GroupField): PinGroup[] {
  const by = new Map<string | null, { order: number; keys: string[] }>();
  for (const p of pins) {
    const raw = fieldValue(p.fields, field.name);
    const text = valueText(raw, field);
    const order = field.type === "measure" ? (asMeasure(raw, field.unit ?? null)?.value ?? Number.POSITIVE_INFINITY) : 0;
    const g = by.get(text) ?? { order, keys: [] };
    g.keys.push(p.key);
    by.set(text, g);
  }
  return [...by.entries()]
    .sort(([a, x], [b, y]) => (a === null ? 1 : b === null ? -1 : x.order - y.order || a.localeCompare(b)))
    .map(([value, g]) => ({ value, label: value ?? `no ${field.label.toLowerCase()}`, keys: g.keys }));
}

/** The short thing a pin says when its whole name does not fit: its first
 *  measure ("10 mm", its Size before its Drive), or null to read it off the
 *  name. The group, if any, is the pin's colour. */
export function shortFor(fields: Record<string, unknown> | null | undefined, groupable: readonly GroupField[]): string | null {
  for (const f of groupable) {
    if (f.type !== "measure") continue;
    const t = valueText(fieldValue(fields, f.name), f);
    if (t) return t;
  }
  return null;
}
