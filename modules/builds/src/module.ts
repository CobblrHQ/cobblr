// builds — light bill-of-materials / assembly for the maker track.
//
// A Build is a recipe: a parent + component lines, each pointing at an inventory
// part + a per-build quantity. The distinctive features: "how many can I build
// right now, and what's the limiting component?" + "build one" consumes the
// components from stock. Consumes inventory ONLY through the inventory API
// (the inventory:adjust-stock action), never a join — cross-module isolation.
//
// Tier 2 = nested sub-assemblies: a component line can be another build, and the
// engine explodes the BoM down to leaf inventory parts. Plus routing: an ordered
// list of operations (steps) per build. A "Maker Workshop" bundle pre-wires
// builds + inventory + purchasing + projects. Strategy: business-models/docs/15
// (operations) + 22 (manufacturing depth ladder — rungs 4+5). Yardsticks:
// docs/design-decisions/pcb-assembly-use-case.md + the maker flagship.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "builds",
  version: "0.3.0",
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
      // The undo: a recorded build was reversed (components returned, output
      // credit removed) — a scrapped/failed fabrication run.
      "builds.build.reversed",
      // Fired when a target build count can't be met — carries the per-component
      // shortfall. Wire it to a purchasing shopping list to auto-restock.
      "builds.shortfall.detected",
      // An operation (routing step) was added to a build.
      "builds.operation.created",
      // An operation crossed into 'done'. Carries build_id + operation_id + name
      // so a wire can react (e.g. mark a linked task done, notify on last step).
      "builds.operation.completed",
      // Shop-floor execution (rung 6): time logged against an operation.
      "builds.operation.time_logged",
      // Scrap recorded at an operation — carries quantity + reason. Wire it to a
      // notification or (later) a quality log.
      "builds.operation.scrapped",
      // Scheduling (rung 7): a planned production order was added.
      "builds.planned.created",
      // A planned order crossed into 'done' — wire to mark a task done / notify.
      "builds.planned.completed",
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
      {
        id: "builds:reverse-one",
        label: "Reverse a build",
        description:
          "Undo a recorded build of N: put each component back into inventory stock and — if the build has an output part — decrement that. The failure leg of builds:build-one (a scrapped/failed fabrication run). Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.reverse-one",
        userInvokable: false,
      },
    ],
  },

  // A fabrication job that produces this build consumes its components on send.
  // digifab fires digifab.job.build_committed { buildId, qty }; build-one reads
  // them off the event. Belongs to builds: it owns the action. Inert for a
  // workspace without digifab (the event never fires) and for a job with no
  // linked build (the event never fires).
  subscribes: ["digifab.job.build_committed", "digifab.job.build_reversed"],

  contributes: {
    wires: [
      {
        source_kind: "digifab:job",
        action_id: "builds:build-one",
        trigger_type: "event",
        trigger_event: "digifab.job.build_committed",
      },
      // The failure leg: a committed build whose job then failed / was cancelled
      // / was scrapped never produced its output — put the components back and
      // remove the output credit. Same payload shape ({ buildId, qty }).
      {
        source_kind: "digifab:job",
        action_id: "builds:reverse-one",
        trigger_type: "event",
        trigger_event: "digifab.job.build_reversed",
      },
    ],
  },
});
