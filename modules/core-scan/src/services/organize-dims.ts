// Declared-dimension extraction for the organize planner (Guided Organize 3b,
// docs/product/guided-organize.md §3.4). Two honest sources, nothing guessed:
//
//   - ENTITIES: numeric fields whose FIELD DEF declares a length-category
//     unit (module_field_defs.unit → the units vocabulary). The declaration
//     is the semantics — a field named anything, with unit "mm", IS a length.
//   - INBOX items: metadata VALUES that literally carry a length unit
//     ("180 mm", "7.5 in") — the unit is present in the data itself.
//
// Unit resolution + conversion go through platform().units (owned by
// core-units — scripts/lint-unit-conversion.ts forbids the math anywhere
// else); each DISTINCT unit string resolves once per plan and values scale by
// the service-provided mm-per-unit factor.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";

/** mm-per-unit for length units, memoized per plan run. Null = not a length
 *  (or the units service is unavailable) → the value carries no size meaning. */
export class LengthUnitResolver {
  private cache = new Map<string, number | null>();
  constructor(private orgId: string) {}

  async mmPerUnit(raw: string): Promise<number | null> {
    const key = raw.trim().toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    let mm: number | null = null;
    const info = await platform().units.resolve(this.orgId, raw);
    if (info?.category === "length") {
      mm = await platform().units.convert(this.orgId, 1, raw, "millimeter");
    }
    this.cache.set(key, mm);
    return mm;
  }
}

interface MetaFieldDefRow {
  module_field_defs: {
    org_id: string;
    entity_kind: string;
    name: string;
    display_label: string;
    type: string;
    unit: string | null;
  };
}

/** The unit-declared number fields per entity kind — the org's declared
 *  physical vocabulary. Read from the platform meta store (field defs are
 *  kernel-owned; reading them is not a cross-module import). */
export async function unitFieldDefsByKind(
  orgId: string,
  kinds: string[],
): Promise<Map<string, Array<{ name: string; display_label: string; unit: string }>>> {
  const out = new Map<string, Array<{ name: string; display_label: string; unit: string }>>();
  if (kinds.length === 0) return out;
  try {
    const meta = platform().db.meta as unknown as Kysely<MetaFieldDefRow>;
    const rows = await meta
      .selectFrom("module_field_defs")
      .select(["entity_kind", "name", "display_label", "unit"])
      .where("org_id", "=", orgId)
      .where("type", "=", "number")
      .where("unit", "is not", null)
      .where("entity_kind", "in", kinds)
      .execute();
    for (const r of rows) {
      const arr = out.get(r.entity_kind) ?? [];
      arr.push({ name: r.name, display_label: r.display_label, unit: r.unit! });
      out.set(r.entity_kind, arr);
    }
  } catch {
    /* meta unavailable → no declared dims, size logic stays dormant */
  }
  return out;
}

export interface DeclaredDims {
  longest_mm: number;
  detail: string;
}

/** An ENTITY's longest declared dimension: max over its numeric field values
 *  whose defs declare a length unit. Field values may live at the top level
 *  or under a metadata blob — both are checked by field name. */
export async function entityLongestMm(
  fields: Record<string, unknown>,
  defs: Array<{ name: string; display_label: string; unit: string }>,
  resolver: LengthUnitResolver,
): Promise<DeclaredDims | null> {
  let best: DeclaredDims | null = null;
  const metadata =
    fields.metadata && typeof fields.metadata === "object"
      ? (fields.metadata as Record<string, unknown>)
      : null;
  for (const def of defs) {
    const raw = fields[def.name] ?? metadata?.[def.name];
    const v = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) continue;
    const mm = await resolver.mmPerUnit(def.unit);
    if (mm == null) continue;
    const asMm = v * mm; // scaling by the units service's factor — no hand-rolled conversion
    if (!best || asMm > best.longest_mm) {
      best = { longest_mm: asMm, detail: `${def.display_label} ${v} ${def.unit}` };
    }
  }
  return best;
}

// "180 mm" / "7.5 in" — a number immediately followed by a unit token. The
// TOKEN is resolved through the vocabulary (never a hardcoded unit list); a
// value that resolves to a non-length unit contributes nothing.
const VALUE_WITH_UNIT = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z"']{1,12})\s*$/;
const MAX_METADATA_KEYS = 24;

/** An INBOX item's longest dimension from metadata values that literally
 *  carry a unit ("overall_length": "180 mm"). The unit is IN the data — as
 *  declared as it gets for a not-yet-committed capture. */
export async function inboxLongestMm(
  metadata: Record<string, unknown> | null | undefined,
  resolver: LengthUnitResolver,
): Promise<DeclaredDims | null> {
  if (!metadata) return null;
  let best: DeclaredDims | null = null;
  let seen = 0;
  for (const [key, raw] of Object.entries(metadata)) {
    if (seen++ >= MAX_METADATA_KEYS) break;
    if (typeof raw !== "string") continue;
    const m = VALUE_WITH_UNIT.exec(raw);
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const mm = await resolver.mmPerUnit(m[2]!);
    if (mm == null) continue;
    const asMm = v * mm;
    if (!best || asMm > best.longest_mm) {
      best = { longest_mm: asMm, detail: `${key} ${raw.trim()}` };
    }
  }
  return best;
}
