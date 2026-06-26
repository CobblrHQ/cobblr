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
  version: "0.1.0",
  displayName: "Units",
  description:
    "Canonical unit vocabulary — built-in units (gram/g, meter/m, each/ea) plus your own, with a shorthand-vs-full-word display toggle. Powers the unit picker on quantity fields.",
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
    actions: [],
  },

  subscribes: [],
});
