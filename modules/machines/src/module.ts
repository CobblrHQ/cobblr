// Machines — generic base module for "physical things I own that
// do something on their own." 3D printers, laser cutters, CNC
// machines all flow through here; type-specific fields come from
// Pillar-E specialisation modules.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "machines",
  version: "0.3.2",
  displayName: "Machines",
  description:
    "Physical machines you own. The base layer. Install a specialisation (3D Printers / Laser Cutters / CNC Machines) for type-specific fields.",
  icon: "wrench",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "machines_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "machines:machine",
        primary: true,
        listEndpoint: "/machines",
        createEndpoint: "/machines",
        updateEndpoint: "/machines/{id}",
        deleteEndpoint: "/machines/{id}",
        displayName: "Machine",
        displayNamePlural: "Machines",
        icon: "wrench",
        profile: "owned-thing" /* physical · unique · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "short_name", type: "text" },
          { name: "family", type: "text" },
          { name: "type", type: "text" },
          { name: "manufacturer", type: "text" },
          { name: "serial_number", type: "text" },
          { name: "state", type: "text" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
        ],
        // Public face — identifying + display fields. Manufacturer is
        // public (you'd want to see "Voron" / "Bambu" on a label) but
        // notes stay private to the owning module's own UI.
        exposableFields: [
          "name",
          "short_name",
          "family",
          "type",
          "manufacturer",
          "state",
          "image_path",
        ],
        detailRoute: "/machines/{id}",
      },
    ],
  },

  intents: [
    { name: "add_machine", description: "Add a new machine" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "machines.machine.created",
      "machines.machine.updated",
      "machines.machine.state_changed",
      "machines.machine.deleted",
    ],
    api: [],
    actions: [
      {
        id: "machines:record-usage",
        examples: ["that machine ran four hours", "log the usage on it"],
        undoable: true,
        label: "Record machine usage",
        description:
          "Add to a machine's lifetime usage counters (print_count, print_hours). Wire it to digifab.print.completed to accrue usage as prints finish: the foundation for maintenance-by-usage ('nozzle due at 500 prints'). Args: { machineId, prints?, hours? }; machineId falls back to the event's linkedMachineId.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.record-usage",
        userInvokable: false,
        argsSchema: {
          machineId: { label: "Machine id", type: "text" },
          prints: { label: "Prints to add", type: "number" },
          hours: { label: "Hours to add", type: "number" },
        },
      },
    ],
  },

  subscribes: ["digifab.print.completed", "digifab.print.reversed"],

  // A completed print accrues usage on the machine it ran on (the event's
  // linkedMachineId). The wire belongs to machines: it owns the action. Inert
  // for a print not linked to a machine, and for any workspace without digifab.
  contributes: {
    wires: [
      {
        source_kind: "digifab:job",
        action_id: "machines:record-usage",
        trigger_type: "event",
        trigger_event: "digifab.print.completed",
      },
      // F-13 — the reverse: a SCRAPPED print fires digifab.print.reversed with
      // { prints: -1 }, un-accruing the one print that print.completed
      // optimistically added (record-usage adds the signed delta). Same handler.
      {
        source_kind: "digifab:job",
        action_id: "machines:record-usage",
        trigger_type: "event",
        trigger_event: "digifab.print.reversed",
      },
    ],
  },
});
