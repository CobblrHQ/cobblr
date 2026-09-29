// Machines — generic base module for "physical things I own that
// do something on their own." 3D printers, laser cutters, CNC
// machines all flow through here; type-specific fields come from
// Pillar-E specialisation modules.

import { defineModule } from "@cobblr/platform-contract";
import { DISPOSITIONS, DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";

export default defineModule({
  name: "machines",
  version: "0.4.0",
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
          // In the order a machine lives them, so a board grouped by state
          // reads as a lifecycle and keeps a column for an empty state. How a
          // machine LEFT is the shared disposition vocabulary, the same words
          // an import's Fate column is read into.
          {
            name: "state",
            type: "text",
            choices: ["kit", "building", "built", "functional", "needs maintenance", "broken", "rebuilding", "loaned", "shelved", ...DISPOSITIONS.map((d) => DISPOSITION_LABELS[d]), "decommissioned"],
          },
          // One record can stand for several identical machines.
          { name: "quantity", type: "number" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
          // The custom fields a workspace adds (a bay, a nozzle size) live in
          // this blob. Declared and exposed as inventory's is, so a view can
          // group, filter and show them: without it every machines board
          // grouped by a custom field put every machine under No value.
          { name: "metadata", type: "object" },
          { name: "quantity", type: "number" },
          // Derived: the machines named under this record, how many of its
          // quantity have no name yet, and on a unit the record it is one of.
          { name: "units", type: "object", readOnly: true },
          { name: "units_not_named", type: "number", readOnly: true },
          { name: "unit_of", type: "object", readOnly: true },
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
          "metadata",
          // How many identical machines the record stands for, and the ones
          // named under it: a reader counting printers needs both.
          "quantity",
          "units",
          "units_not_named",
          "unit_of",
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
      // One record standing for N identical machines, any of them given an
      // identity of its own (docs/design-decisions/holdings-and-units.md,
      // phase 5). The same doors the machine's page uses.
      {
        id: "machines:name-unit",
        examples: ["the second Replicator is the one with the new hotend", "give one of these its own name"],
        label: "Name one of these",
        description:
          "This record counts several identical machines: give one of them an identity of its own (its own name, serial, state, notes, service log, label and links), still counted under this record. The quantity does not change. Refused when every one already has a name. Args: { name?: string, serial_number?: string }.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.name-unit",
        userInvokable: false,
        argsSchema: {
          name: { label: "Name", type: "text" },
          serial_number: { label: "Serial number", type: "text" },
        },
      },
      {
        id: "machines:split-unit",
        examples: ["unit 2 is its own machine now", "split this one out"],
        undoable: true,
        label: "Split into its own",
        description:
          "This machine is one unit of another record: make it a machine record of its own, keeping its name, history, links and label. The other record counts one fewer. Run it on the unit.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.split-unit",
        userInvokable: false,
      },
      {
        id: "machines:split-one",
        examples: ["one of the five printers is going to the other shop, track it on its own"],
        undoable: true,
        label: "Split one off",
        description:
          "This record counts several identical machines: one of the ones without a name of its own becomes a machine record of its own (same make, type, state and place). This record counts one fewer. Args: { name?: string }.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.split-one",
        userInvokable: false,
        argsSchema: { name: { label: "Name", type: "text" } },
      },
      {
        id: "machines:make-unit-of",
        examples: ["this printer is one of the three Replicators", "merge it back into the group"],
        undoable: true,
        label: "Make it one unit of…",
        description:
          "This single machine is one of the identical machines another record counts: make it a unit of that record, which then counts one more. Only a record that counts one machine, in the same collection. Args: { parent_id: the other record's id }.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.make-unit-of",
        userInvokable: false,
        argsSchema: { parent_id: { label: "One unit of (machine id)", type: "text", required: true } },
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
