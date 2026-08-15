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
  version: "0.2.0",
  displayName: "Units",
  description:
    "Canonical unit vocabulary: built-in units (gram/g, meter/m, each/ea) plus your own, with a shorthand-vs-full-word display toggle. Powers the unit picker on quantity fields.",
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
    api: [],
    actions: [
      {
        // WORKSPACE-scoped: it teaches the workspace a word, it does not run on
        // a record. This is what makes "we measure rope in fathoms" reachable
        // through the generic invoke_action rail rather than a bespoke AI tool
        // — the labels:set-code pattern. Purely additive: a new code never
        // rewrites a value already stored against a different one.
        id: "core-units:add-unit",
        label: "Add a unit",
        description:
          "Teach this workspace a unit it does not have yet (a fathom, a skein, a board-foot) so quantity fields can be measured in it. Runs on the workspace, not a record. The built-ins already cover mass, length, area, volume, time, count, electrical and digital, so check those first.",
        icon: "ruler",
        scope: "workspace",
        invokeHandler: "core-units.add-unit",
        argsSchema: {
          code: { label: "Code (lowercase, e.g. fathom)", type: "text" },
          symbol: { label: "Symbol shown next to a number (e.g. ftm)", type: "text" },
          name: { label: "Singular name", type: "text" },
          plural: { label: "Plural name", type: "text" },
          category: { label: "What it measures (length, mass, volume, count, …)", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
