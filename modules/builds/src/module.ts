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
  version: "0.1.14",
  displayName: "Builds",
  description:
    "Describe what you make as a recipe of parts, see how many you could build right now and what runs out first, and take the parts from stock when you build one.",
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
        createEndpoint: "/builds",
        updateEndpoint: "/builds/{id}",
        deleteEndpoint: "/builds/{id}",
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
        // A bundle's own fields ride in `metadata`, readable like a part's,
        // so a view or a label naming one prints its value.
        exposableFields: ["name", "description", "metadata"],
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
    actions: [
      {
        id: "builds:build-one",
        examples: ["built one of those", "make two of these"],
        undoable: true,
        label: "Build one",
        description:
          "Record building N of a build: decrement each component from inventory stock (via inventory:adjust-stock), log a build run, and (if the build has an output part) increment that. Generic capability; a bundle/app composes it. Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.build-one",
        userInvokable: true,
        argsSchema: {
          build_id: { label: "Build id", type: "text" },
          qty: { label: "How many to build", type: "number" },
        },
      },
      {
        // NO-PHRASING: a wire target the good print verdict fires; nobody asks for it by name
        id: "builds:credit-output",
        label: "Count a build's output as made",
        description:
          "Add a build's output part to stock for N builds that came out good. The second half of builds:build-one when a fabrication job defers its output to the good verdict (a failed or scrapped print adds nothing). Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.credit-output",
        argsSchema: {
          build_id: { label: "Which build made the output, defaults to the record this ran on", type: "text" },
          qty: { label: "How many builds came out good, defaults to 1", type: "number" },
        },
        userInvokable: false,
      },
      {
        // NO-PHRASING: a wire target the print verdict fires; nobody asks for it by name
        id: "builds:record-yield",
        label: "Record a print's good and scrap",
        description:
          "Write a judged print's counts (good, scrap) into the build's quantity log, so the build and its work orders read one yield. Fired by digifab.job.outcome; counts once per job. Args: none (reads the event).",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.record-yield",
        argsSchema: {},
        userInvokable: false,
        wireOnly: true,
      },
      {
        // NO-PHRASING: the door behind an order line's "Make this"; people ask the order, not builds
        // UI-REACH: a sales order line's "Make this" button plans it (sales POST /orders/:id/items/:itemId/make)
        id: "builds:plan-for",
        label: "Plan a work order for a part",
        description:
          "Plan the build that makes a part, for a record in another module (a sales order): a work order of qty, which closes by itself when that many good ones have been counted. Refuses when no build makes the part. Asking again for the same record sets the qty. Args: { part_id, qty, source_kind?, source_id?, due_date? }.",
        scope: "workspace" as const,
        invokeHandler: "builds.plan-for",
        argsSchema: {
          part_id: { label: "The part to make", type: "text", required: true },
          qty: { label: "How many", type: "number", required: true },
          source_kind: { label: "The kind of record it is made for", type: "text" },
          source_id: { label: "The record it is made for", type: "text" },
          due_date: { label: "When it is due, ISO date", type: "text" },
        },
        userInvokable: false,
      },
      {
        // NO-PHRASING: a read another module makes of its own work orders; nobody asks for it by name
        // UI-REACH: a sales order's lines show what is being made for them and how many are made (sales GET /orders/:id)
        id: "builds:work-orders-for",
        label: "Work orders made for a record",
        description:
          "The work orders planned for one record, each with its build, qty, how many are made (good parts, handed out oldest order first) and whether it is done. Changes nothing. Args: { source_kind, source_id }.",
        scope: "workspace" as const,
        invokeHandler: "builds.work-orders-for",
        argsSchema: {
          source_kind: { label: "The kind of record", type: "text", required: true },
          source_id: { label: "The record", type: "text", required: true },
        },
        userInvokable: false,
      },
      {
        id: "builds:reverse-one",
        examples: ["that build failed", "undo the last build"],
        undoable: true,
        label: "Reverse a build",
        description:
          "Undo a recorded build of N: put each component back into inventory stock and (if the build has an output part) decrement that. The failure leg of builds:build-one (a scrapped/failed fabrication run). Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.reverse-one",
        argsSchema: {
          build_id: { label: "Which build to reverse, defaults to the record this ran on", type: "text" },
          qty: { label: "How many to reverse, defaults to 1", type: "number" },
        },
        userInvokable: false,
      },
    ],
  },

  // A fabrication job that produces this build consumes its components on send
  // (digifab.job.build_committed { buildId, qty }, read by build-one) and
  // counts its output when the plate is judged good (digifab.job.build_output). Belongs to builds: it owns the action. Inert for a
  // workspace without digifab (the event never fires) and for a job with no
  // linked build (the event never fires).
  subscribes: ["digifab.job.build_committed", "digifab.job.build_output", "digifab.job.build_reversed", "digifab.job.outcome"],

  contributes: {
    wires: [
      {
        source_kind: "digifab:job",
        action_id: "builds:build-one",
        trigger_type: "event",
        trigger_event: "digifab.job.build_committed",
      },
      // The output leg: the plate was judged good, so its output counts as made
      // (#4050). Payload { buildId, qty } is the good count.
      {
        source_kind: "digifab:job",
        action_id: "builds:credit-output",
        trigger_type: "event",
        trigger_event: "digifab.job.build_output",
      },
      // The quality leg: every judged print that produced a build writes its
      // good and scrap into the build's quantity log (#4053), so the plate
      // verdict and the build's own yield are one record, not two.
      {
        source_kind: "digifab:job",
        action_id: "builds:record-yield",
        trigger_type: "event",
        trigger_event: "digifab.job.outcome",
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
