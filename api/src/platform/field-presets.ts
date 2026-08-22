// VOCAB-ENUMERATION OK: a preset's whole content is a DECLARATION of what its
// fields mean, so naming the roles here is the point rather than a leak of the
// vocabulary into generic code. Nothing below reads a role or branches on one;
// it only states which one each field claims.
//
// A named set of role-tagged fields you switch on.
//
// Not a bundle. A bundle is a thing you INSTALL: it has a version, an uninstall,
// a refcount, and it can bring wires, views and instances with it. A preset only
// makes fields exist. That difference is the whole reason this exists - the ask
// was "literally a 1 click setting somewhere and it's on", not another trip
// through the marketplace.
//
// Why it has to declare ROLES: a fact the scan pipeline establishes reaches an
// item through role mapping, so a field with no role never receives one. The
// no-code /fields form cannot set a role, which is why building these three by
// hand looked equivalent and was not - a hand-made "Acquired on" is inert, and
// the receipt's date lands nowhere.
//
// See docs/design-decisions/field-presets.md.

import type { FieldRole, TraitName } from "@cobblr/platform-contract";

export interface PresetField {
  name: string;
  display_label: string;
  type: "text" | "number" | "date" | "url";
  /** What this field MEANS, so the pipeline can fill it. The point of a preset. */
  field_role: FieldRole;
  help?: string;
}

// NO `choices` here, deliberately, and it is not an oversight.
//
// `roledFactsPatch` refuses to write a value that is not in a field's choice
// list (`if (m.unlistedChoice) continue`) - a good rule, because a pipeline
// should not silently invent a new option for a field someone made a dropdown.
//
// But a preset field exists to BE filled by the pipeline, so a closed list on
// one is a contradiction that discards the very fact it was created for.
// Measured: `acquired_from` shipped with six channel-ish options (Bought new,
// Gift, ...), a receipt named "KC Tool", and the vendor was dropped on the
// floor while the date beside it landed fine (2026-08-22).
//
// A workspace can still turn any of these into a dropdown afterwards in the
// field editor; that is their choice to make, with their own vocabulary, and
// they will see the values already there.

export interface FieldPreset {
  key: string;
  label: string;
  hint: string;
  /** Which things it lands on, as traits - so a kind installed next month
   *  inherits it with no migration. */
  traits: TraitName[];
  fields: PresetField[];
}

export const FIELD_PRESETS: FieldPreset[] = [
  {
    key: "provenance",
    label: "Provenance",
    hint: "Where each thing came from, when, and what it cost.",
    traits: ["physical"],
    fields: [
      {
        name: "acquired_from",
        display_label: "Acquired from",
        type: "text",
        field_role: "acquired-from",
        help: "Where it came from - a shop, a marketplace, a person. A receipt fills this from the vendor it names.",
      },
      {
        name: "acquired_on",
        display_label: "Acquired on",
        type: "date",
        field_role: "acquired-on",
        help: "When it became yours. A receipt fills this from the date printed on it, which is not always the day you scanned it.",
      },
      {
        name: "acquired_for",
        display_label: "Paid",
        type: "number",
        field_role: "acquired-for",
        help: "What it cost you. A receipt fills this only when its own numbers reconciled.",
      },
    ],
  },
];

export const findFieldPreset = (key: string): FieldPreset | undefined =>
  FIELD_PRESETS.find((p) => p.key === key);

/** One of a preset's fields, as it stands in a workspace right now. */
export interface PresetFieldState {
  name: string;
  display_label: string;
  present: boolean;
}

export interface PresetState {
  key: string;
  label: string;
  hint: string;
  traits: TraitName[];
  /** `on` = every field present. `off` = none. `partial` = some, which is a real
   *  state (one was deleted, or the preset gained a field) and is shown as one
   *  rather than rounded to on or off. */
  status: "on" | "off" | "partial";
  present: number;
  total: number;
  fields: PresetFieldState[];
}

/**
 * What switching this preset ON has to do, given what is already there.
 *
 * Pure, so the on/off/partly-on decisions are testable without a database - and
 * they are the part that is easy to get wrong. Creating a field that already
 * exists is the bug that makes a "setting" produce duplicates.
 */
export function presetState(preset: FieldPreset, existing: PresetFieldState[]): PresetState {
  const byName = new Map(existing.map((f) => [f.name, f]));
  const fields = preset.fields.map((f) => {
    const found = byName.get(f.name);
    return {
      name: f.name,
      display_label: f.display_label,
      present: !!found?.present,
    };
  });
  const present = fields.filter((f) => f.present).length;
  return {
    key: preset.key,
    label: preset.label,
    hint: preset.hint,
    traits: preset.traits,
    status: present === 0 ? "off" : present === preset.fields.length ? "on" : "partial",
    present,
    total: preset.fields.length,
    fields,
  };
}

/** The fields switching ON must create: the missing ones, and only those. */
export function fieldsToCreate(preset: FieldPreset, state: PresetState): PresetField[] {
  const missing = new Set(state.fields.filter((f) => !f.present).map((f) => f.name));
  return preset.fields.filter((f) => missing.has(f.name));
}

/**
 * The fields switching this preset OFF removes: the ones that are there.
 *
 * Removing a field DEF does not destroy anything anyone typed - the values stay
 * on the items, in the same jsonb they always lived in, and reappear the moment
 * the preset is switched back on. That is how every field deletion in this
 * platform already behaves, and the switch says so rather than implying it
 * throws work away.
 */
export function fieldsToRemove(state: PresetState): string[] {
  return state.fields.filter((f) => f.present).map((f) => f.name);
}
