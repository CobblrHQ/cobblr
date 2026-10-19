import { centsFromAmount } from "@cobblr/platform-contract/money";
import { fieldNoteKey, type FieldRole, isListedChoice, ROLE_CLARIFIES } from "@cobblr/platform-contract/field-vocabulary";

// Facts tagged by ROLE, landed on whatever the workspace calls those things.
//
// TWO rules, and the second one is the one that keeps getting broken:
//
//   1. Never match on a field's NAME. A mapper looking for `acquired_from`
//      works in exactly the workspace that inspired it and silently does
//      nothing in every other.
//   2. Never enumerate the CONCEPTS either. An earlier version of this had one
//      branch per role and a four-property input type, so adding a fifth fact
//      meant editing the mapper. That is the same hardcoding as rule 1, moved
//      one level up and easier to miss, because the field names were generic
//      and it therefore looked finished.
//
// So this layer knows nothing about receipts, vendors, or prices. It is a
// matcher: role-tagged facts in, metadata keys out. Adding a fact means adding
// a role to the vocabulary and teaching the EXTRACTOR to produce it. Nothing
// here changes.
//
// Pure: no db, no platform(), no module imports.
// Lives in the contract because the scan inbox owns the confirm path and a
// module may not import api internals.
//
// See docs/design-decisions/arrivals.md.

/** What was found, keyed by what it MEANS. The extractor owns every judgment
 *  about which fact is which; this layer owns only where each one lands. */
export type RoledFacts = Partial<Record<FieldRole, string | number>>;

/** The subset of a field def the matcher needs. Structural so callers can pass
 *  their own rows without a conversion step. */
export interface RoledField {
  name: string;
  field_role?: string | null;
  type?: string | null;
  choices?: string[] | null;
  /** A column of the kind's own (a vehicle's Paid, Purchased at), written
   *  through the kind's writer, never into metadata. */
  native?: boolean;
  /** How a native money column stores its amount; a fact's money is put in
   *  that unit (cents) before it is written. */
  money?: "cents" | "amount" | null;
  /** The list is open: a value off it is still this field's value (field-choices
   *  `choiceLearns`, decided by whoever hands the field over). A parser's value
   *  is written but never added to the list. Absent = a closed list. */
  learns?: boolean | null;
}

/** One workspace-defined field on a kind, as `fieldsFor` reports it. */
export interface DefinedField extends RoledField {
  ref_kind?: string | null;
  display_label: string;
  type: string;
  /** The declared unit of a number field ("m", "g"), when it has one. */
  unit?: string | null;
  /** A computed field's template ("{{ length_per_skein }}"). */
  template?: string | null;
  /** Once filled, an update may not empty it. A create may leave it empty:
   *  capture comes before structure, and the record then shows what it needs. */
  required?: boolean;
  /** The owner marked it private: shares and public pages leave it out unless
   *  they show private notes (@cobblr/platform-contract/share-scope). */
  private?: boolean;
}

export interface MappedValue {
  /** The key to write: a metadata key, or a native column when `native`. */
  key: string;
  /** A column of the kind's own: written through the kind's writer. */
  native?: boolean;
  value: string | number;
  /** Which role put it there, so a confirm UI can explain itself. */
  role: FieldRole;
  /** True when this rode in as a clarifier beside another field's value rather
   *  than as a value in its own right. */
  isNote?: boolean;
  /** Set when the value is not in that field's `choices` yet, so the UI can
   *  OFFER to add it rather than adding it silently. */
  unlistedChoice?: boolean;
}



/**
 * Land each fact on the field that declares its role.
 *
 * A workspace declaring no roles gets an empty result, which is today's
 * behaviour and stays correct: nothing is invented and no field is created.
 */
export function mapRoledFacts(
  facts: RoledFacts,
  fields: readonly RoledField[],
): MappedValue[] {
  const byRole = new Map<string, RoledField>();
  for (const f of fields) {
    if (f.field_role && !byRole.has(f.field_role)) byRole.set(f.field_role, f);
  }

  const out: MappedValue[] = [];
  for (const [r, value] of Object.entries(facts)) {
    const role = r as FieldRole;
    if (value == null || value === "") continue;

    const field = byRole.get(role);
    if (field) {
      const unlisted = field.learns !== true && typeof value === "string" && (field.choices?.length ?? 0) > 0 && !isListedChoice(value, field.choices!);
      // A money fact is an amount; a column that keeps cents gets cents.
      const stored = field.money === "cents" && typeof value === "number" ? centsFromAmount(value) : value;
      out.push({ key: field.name, value: stored, role, ...(field.native ? { native: true } : {}), ...(unlisted ? { unlistedChoice: true } : {}) });
      continue;
    }

    // No field of its own. If this role clarifies another, ride along there.
    const hostRole = ROLE_CLARIFIES[role];
    const host = hostRole ? byRole.get(hostRole) : undefined;
    if (host) out.push({ key: fieldNoteKey(host.name), value, role, isNote: true });
  }
  return out;
}

/** The metadata patch, for a caller that just wants to write it. Values the UI
 *  must confirm first (an unlisted choice) are EXCLUDED: offering to add a
 *  choice and then adding it anyway would make the offer decorative. A value
 *  for a native column is not metadata and is left out: `roledNativePatch`
 *  has it. */
export function roledFactsPatch(mapped: readonly MappedValue[]): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const m of mapped) {
    if (m.unlistedChoice || m.native) continue;
    patch[m.key] = m.value;
  }
  return patch;
}

/** The writes for the kind's own columns (a vehicle's Paid, Purchased at,
 *  Bought from), for the kind's writer. */
export function roledNativePatch(mapped: readonly MappedValue[]): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  for (const m of mapped) {
    if (m.unlistedChoice || !m.native) continue;
    patch[m.key] = m.value;
  }
  return patch;
}
