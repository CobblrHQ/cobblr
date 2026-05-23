// Workshop Mods — Pillar-E specialisation that extends
// projects:project for the "modification project on a machine"
// workflow. A "mod" is a project with a slightly different state
// vocabulary and a polymorphic pairing back to a machine.
//
// Cross-module convention: a mod's link to its machine is encoded
// as an entity_pairings row with relationship_kind="modifies"
// (source=projects:project, target=machines:machine).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "workshop-mods",
  version: "0.1.0",
  displayName: "Workshop Mods",
  description:
    "Extends projects with the mod-on-a-machine workflow: substate vocabulary (parts-needed / ready / in-progress), energy estimate, excitement, public visibility. Mod ↔ machine link rides on the pairings primitive (relationship_kind='modifies').",
  icon: "tool",
  band: "user",

  dependencies: ["projects", "machines"],

  contributes: {
    fieldDefs: [
      {
        entity_kind: "projects:project",
        name: "mod_substate",
        display_label: "Mod substate",
        type: "text",
        position: 50,
        choices: ["planning", "parts-needed", "ready", "in-progress", "done", "abandoned"],
      },
      {
        entity_kind: "projects:project",
        name: "mod_energy",
        display_label: "Energy estimate",
        type: "text",
        position: 51,
        choices: ["small", "medium", "large"],
      },
      {
        entity_kind: "projects:project",
        name: "mod_excitement",
        display_label: "Excitement (0-5)",
        type: "number",
        position: 52,
      },
      {
        entity_kind: "projects:project",
        name: "mod_external_url",
        display_label: "External URL",
        type: "url",
        position: 53,
      },
      {
        entity_kind: "projects:project",
        name: "mod_public_visible",
        display_label: "Public visible",
        type: "boolean",
        position: 54,
      },
    ],
    wires: [],
  },

  provides: { entityKinds: [] },
  intents: [],
  exposes: { events: [], api: [], actions: [] },
  subscribes: [],
});
