// builds — light bill-of-materials / assembly for the maker track.
//
// A Build is a recipe: a parent + component lines, each pointing at an inventory
// part + a per-build quantity. The distinctive features: "how many can I build
// right now, and what's the limiting component?" + "build one" consumes the
// components from stock. Consumes inventory ONLY through the inventory API
// (the inventory:adjust-stock action), never a join — cross-module isolation.
//
// Tier 1 = flat builds (no nested sub-assemblies). A "Maker Workshop" bundle
// pre-wires builds + inventory + purchasing + projects. Strategy:
// business-models/docs/15 (operations) + 08 (flagship). Yardsticks:
// docs/design-decisions/pcb-assembly-use-case.md + the maker flagship.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "builds",
  version: "0.1.0",
  displayName: "Builds",
  description:
    "Light bill-of-materials: define a build as a recipe of inventory parts, see how many you can build right now (and the limiting component), and consume the parts from stock when you build one. For makers assembling things from tracked parts.",
  icon: "hammer",
  band: "stock",
  autoEnable: false,

  schema: {
    tablePrefix: "builds_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "builds:build",
        displayName: "Build",
        displayNamePlural: "Builds",
        icon: "hammer",
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "notes", type: "text" },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["name", "description"],
        detailRoute: "/builds/{id}",
        getEndpoint: "/builds/{id}",
      },
    ],
  },

  exposes: {
    events: [
      "builds.build.created",
      // Fired when a build is recorded (components consumed). Carries build_id +
      // qty_built so a wire can react (e.g. mark a linked task done).
      "builds.build.completed",
      // Fired when a target build count can't be met — carries the per-component
      // shortfall. Wire it to a purchasing shopping list to auto-restock.
      "builds.shortfall.detected",
    ],
    api: [],
    actions: [
      {
        id: "builds:build-one",
        label: "Build one",
        description:
          "Record building N of a build: decrement each component from inventory stock (via inventory:adjust-stock), log a build run, and — if the build has an output part — increment that. Generic capability; a bundle/app composes it. Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.build-one",
        userInvokable: true,
        argsSchema: {
          build_id: { label: "Build id", type: "text" },
          qty: { label: "How many to build", type: "number" },
        },
      },
    ],
  },

  subscribes: [],
});
