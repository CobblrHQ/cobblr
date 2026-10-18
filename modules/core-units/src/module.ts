// core-units — the workspace's unit vocabulary.
//
// A free-text `unit` field ("each", "g", "grams") means the same unit
// never correlates across entities and can't offer a shorthand-vs-full-word
// display toggle. core-units supplies a canonical vocabulary: built-in
// units (gram/g, meter/m, each/ea, …) in code + per-workspace custom units
// + a display-mode preference (symbol / name / both). It resolves a stored
// value to a catalog entry for display and feeds the unit picker.
//
// Ambient capability (NOT foundational): ON for every workspace and carries
// no entity kind — a vocabulary other modules' fields lean on, not a thing
// you browse. Because storage stays free-text, the platform works without it
// (it fails the strict "can't work without it" foundational test), so it's a
// `stock` capability with autoEnable, not foundational — which keeps it
// disableable. (Audit 2026-06-26 P1 #2.)

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-units",
  version: "0.3.0",
  displayName: "Units",
  description:
    "The units you count and measure in (grams, metres, pieces, your own), shown the way you like.",
  icon: "ruler",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace, but disableable

  schema: {
    tablePrefix: "core_units_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [],
    actions: [
      {
        // WORKSPACE-scoped, and also the way back for add-unit.
        group: "more",
        // UI-SCREEN: /configuration/units
        id: "core-units:remove-unit",
        changes: "records",
        // ADMIN-ONLY: the page's own route DELETE /units/:code is owner or admin (units.ts)
        runBy: "admin",
        examples: ["remove the fathom unit", "we don't measure in balls any more"],
        undoable: true,
        label: "Remove a unit",
        description:
          "Remove a unit this workspace added (never a built-in one). Quantities already stored in it keep their numbers; Undo puts the unit back as it was.",
        icon: "ruler",
        scope: "workspace" as const,
        invokeHandler: "core-units.remove-unit",
        argsSchema: {
          code: { label: "Which unit (its code or name)", type: "text", required: true },
        },
      },
      {
        // WORKSPACE-scoped: it teaches the workspace a word, it does not run on
        // a record. This is what makes "we measure rope in fathoms" reachable
        // through the generic invoke_action rail rather than a bespoke AI tool
        // — the labels:set-code pattern. Purely additive: a new code never
        // rewrites a value already stored against a different one.
        // UI-SCREEN: /configuration/units
        group: "more",
        id: "core-units:add-unit",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /units gates on this action's own id, owner or admin (units.ts)
        runBy: "admin",
        examples: ["we measure yarn in balls", "add a fathom unit"],
        undoable: true,
        label: "Add a unit",
        description:
          "Teach this workspace a unit it does not have yet (a fathom, a ball, a board-foot) so quantity fields can be measured in it. Runs on the workspace, not a record. The built-ins already cover mass, length, area, volume, time, count, electrical and digital, so check those first.",
        icon: "ruler",
        scope: "workspace",
        invokeHandler: "core-units.add-unit",
        argsSchema: {
          code: { label: "Code (lowercase, e.g. fathom)", type: "text", required: true },
          symbol: { label: "Symbol shown next to a number (e.g. ftm)", type: "text", required: true },
          name: { label: "Singular name", type: "text", required: true },
          plural: { label: "Plural name", type: "text" },
          category: { label: "What it measures (length, mass, volume, count, …)", type: "text" },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/units
        id: "core-units:set-display-mode",
        changes: "workspace",
        // ADMIN-ONLY: the page's own route PUT /units/settings is owner or admin (units.ts)
        runBy: "admin",
        examples: ["show units as full names", "use unit symbols"],
        undoable: true,
        label: "Show units as symbols or names",
        description:
          "Choose how quantities show their unit across the workspace: the symbol (3 kg), the name (3 kilograms), or both. Undo puts back what it was.",
        icon: "ruler",
        scope: "workspace",
        invokeHandler: "core-units.set-display-mode",
        userInvokable: true,
        argsSchema: {
          display_mode: { label: "symbol, name or both", type: "text", required: true },
        },
      },
    ],
  },

  subscribes: [],
});
