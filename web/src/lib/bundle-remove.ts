// One Remove for an installed bundle, from whichever door (its row on the
// Bundles page, its sheet): the same words and the same choice. The row used
// to keep a bundle's records and the sheet to delete them, under the same
// word "Remove", so which one you pressed decided whether your records
// survived.
export interface RemovePreview {
  instances: { name: string; display_name: string; item_count: number }[];
  modules: string[];
  module_names?: string[];
  places?: { id: string; name: string }[];
  kept?: { type: "module" | "place"; name: string; reason: string }[];
}

export interface RemovePlan {
  /** What goes whatever is chosen. */
  always: string;
  /** Present when the bundle's collections hold records: keep them or not. */
  choice: { keepLabel: string; deleteLabel: string } | null;
  /** What is chosen when nothing is: keep, whenever there is anything to keep. */
  defaultDelete: boolean;
  /** What stays however it goes, and why. */
  stays: string[];
}

const items = (n: number) => `${n} record${n === 1 ? "" : "s"}`;

export function planRemove(preview: RemovePreview | null): RemovePlan {
  const withRecords = (preview?.instances ?? []).filter((i) => i.item_count > 0);
  // What goes only when the collections go with it: a module left with
  // nothing in it, an empty place the install made. Kept records keep them.
  const alsoOff: string[] = [];
  const alsoDo: string[] = [];
  const mods = preview?.module_names ?? preview?.modules ?? [];
  if (mods.length) {
    alsoOff.push(`turns off ${mods.join(", ")}`);
    alsoDo.push(`turn off ${mods.join(", ")}`);
  }
  if (preview?.places?.length) {
    const places = preview.places.map((p) => p.name).join(", ");
    alsoOff.push(`removes the empty ${places}`);
    alsoDo.push(`remove the empty ${places}`);
  }
  const stays = (preview?.kept ?? []).map((k) => `${k.name} stays: ${k.reason}.`);
  const always = "This removes its fields, automations and views.";
  if (!withRecords.length) {
    const empty = (preview?.instances ?? []).map((i) => i.display_name);
    const rest = [...(empty.length ? [`removes ${empty.join(", ")}, which ${empty.length === 1 ? "is" : "are"} empty`] : []), ...alsoOff];
    return { always: rest.length ? `This removes its fields, automations and views, ${rest.join(", and ")}.` : always, choice: null, defaultDelete: empty.length > 0, stays };
  }
  const list = withRecords.map((i) => `${i.display_name} (${items(i.item_count)})`).join(", ");
  return {
    always,
    choice: {
      keepLabel: `Keep ${list}. You can put the bundle back and they are there.`,
      deleteLabel: `Delete ${list} too${alsoDo.length ? `, and ${alsoDo.join(", and ")}` : ""}. This cannot be undone.`,
    },
    defaultDelete: false,
    stays,
  };
}
