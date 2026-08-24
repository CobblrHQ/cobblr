// Turning a field preset on or off in one workspace.
//
// Separate from field-presets.ts on purpose: that file is the DECLARATION plus
// pure helpers, imported by unit tests that boot nothing, and it stays that way.
// This is the half that touches the database, shared by the preset routes and
// the platform:set-field-preset action so the switch means the same thing
// whichever asks.

import { fieldScopeSentinel } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { createFieldDef } from "./field-defs.js";
import {
  type FieldPreset,
  type PresetFieldState,
  type PresetState,
  fieldsToCreate,
  fieldsToRemove,
  findFieldPreset,
  presetState,
} from "./field-presets.js";

/** Which of a preset's fields exist in this workspace right now. */
export async function presetFieldStates(orgId: string, preset: FieldPreset): Promise<PresetFieldState[]> {
  const sentinel = fieldScopeSentinel(preset.traits);
  const rows = await meta
    .selectFrom("module_field_defs")
    .select(["name", "display_label"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", sentinel)
    .execute();
  const have = new Set(rows.map((r) => r.name));
  return preset.fields.map((f) => ({
    name: f.name,
    display_label: f.display_label,
    present: have.has(f.name),
  }));
}

export type PresetSwitchResult =
  | { ok: true; state: PresetState; created?: string[]; removed?: string[]; failed?: Array<{ name: string; message: string }> }
  | { ok: false; code: "unknown_preset"; message: string };

export async function turnPresetOn(orgId: string, key: string): Promise<PresetSwitchResult> {
  const preset = findFieldPreset(key);
  if (!preset) return { ok: false, code: "unknown_preset", message: "No such field preset." };
  const before = presetState(preset, await presetFieldStates(orgId, preset));
  const created: string[] = [];
  const failed: Array<{ name: string; message: string }> = [];
  for (const f of fieldsToCreate(preset, before)) {
    const result = await createFieldDef(orgId, {
      entity_kind: "",
      applies_to: { traits: preset.traits },
      name: f.name,
      display_label: f.display_label,
      type: f.type,
      field_role: f.field_role,
      ...(f.help ? { help: f.help } : {}),
    });
    if (result.ok) created.push(f.name);
    // A name already taken by a field this preset did not make is not an error
    // to shout about: the preset is partly on because the workspace already had
    // one, and saying so is more useful than failing the switch.
    else failed.push({ name: f.name, message: result.message });
  }
  const state = presetState(preset, await presetFieldStates(orgId, preset));
  return { ok: true, state, created, ...(failed.length ? { failed } : {}) };
}

export async function turnPresetOff(orgId: string, key: string): Promise<PresetSwitchResult> {
  const preset = findFieldPreset(key);
  if (!preset) return { ok: false, code: "unknown_preset", message: "No such field preset." };
  const state = presetState(preset, await presetFieldStates(orgId, preset));
  const names = fieldsToRemove(state);
  if (names.length > 0) {
    await meta
      .deleteFrom("module_field_defs")
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", fieldScopeSentinel(preset.traits))
      .where("name", "in", names)
      .execute();
  }
  // Values already recorded stay on the items, exactly as they do for any other
  // field deletion, and come back if the preset is switched on again.
  return { ok: true, state: presetState(preset, await presetFieldStates(orgId, preset)), removed: names };
}
