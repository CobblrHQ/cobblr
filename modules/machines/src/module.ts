// Machines — generic base module for "physical things I own that
// do something on their own." 3D printers, laser cutters, CNC
// machines all flow through here; type-specific fields come from
// Pillar-E specialisation modules.

import { defineModule } from "@cobblr/platform-contract";
import { DISPOSITIONS, DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";

export default defineModule({
  name: "machines",
  version: "0.6.0",
  displayName: "Machines",
  description:
    "The machines you run, with a specialisation for each type (3D printers, laser cutters, CNC machines) that adds the details that type needs.",
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
        // Its category is its own `type` field ("Type / category" on the
        // form): the scan category axis answers from it, not a second field.
        categoryField: "type",
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
          { name: "serial_number", type: "text", fieldRole: "identifier" },
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
          // Where it is, by name: its place, or what it is inside ("Backpack,
          // in Desk drawer"). Derived on read, so a search or the assistant can
          // say where it is.
          { name: "location_name", type: "text", readOnly: true },
          // What it runs. Its driver reports these when it can; a person types
          // them when it cannot. The source and last-seen are the module's:
          // a reading nobody has seen for a while is never counted current.
          { name: "firmware_version", type: "text", label: "Firmware" },
          { name: "software_version", type: "text", label: "Software" },
          { name: "controller", type: "text", label: "Firmware family" },
          { name: "firmware_source", type: "text", label: "Firmware from", readOnly: true },
          { name: "firmware_seen_at", type: "date", label: "Firmware last seen", readOnly: true },
          { name: "software_source", type: "text", label: "Software from", readOnly: true },
          { name: "software_seen_at", type: "date", label: "Software last seen", readOnly: true },
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
          "location_name",
        ],
        detailRoute: "/machines/{id}",
      },
    ],
  },

  dependencies: [],

  exposes: {
    events: [
      "machines.machine.created",
      "machines.machine.updated",
      "machines.machine.state_changed",
      "machines.machine.deleted",
      // A machine's use was recorded: { orgId, machine: { kind, id }, prints,
      // hours, cycles }. What is installed in it wears by the same amounts.
      "machines.usage.recorded",
    ],
    actions: [
      {
        group: "service",
        id: "machines:record-usage",
        changes: "records",
        runBy: "member",
        examples: ["that machine ran four hours", "log the usage on it"],
        undoable: true,
        label: "Record machine usage",
        description:
          "Add to a machine's lifetime usage counters (run_hours, print_count, print_hours, cycles), and the same use to every tool installed in it, so a schedule on the machine or on a tool comes due by use ('nozzle due at 500 prints', 'suction cups every 200,000 picks'). Digifab completion events supply the finished job's hours on its linked machine, and a robot arm's cycles. Args: { machineId, prints?, hours?, cycles? }; machineId falls back to the event's linkedMachineId.",
        appliesTo: { kinds: ["machines:machine"] },
        invokeHandler: "machines.record-usage",
        userInvokable: false,
        argsSchema: {
          machineId: { label: "Machine id", type: "text" },
          prints: { label: "Prints to add", type: "number" },
          hours: { label: "Hours to add", type: "number" },
          cycles: { label: "Cycles to add", type: "number" },
        },
      },
      // One record standing for N identical machines, any of them given an
      // identity of its own (docs/design-decisions/holdings-and-units.md,
      // phase 5). The same doors the machine's page uses.
      {
        group: "service",
        id: "machines:name-unit",
        changes: "records",
        runBy: "member",
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
        group: "service",
        id: "machines:split-unit",
        changes: "records",
        runBy: "member",
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
        group: "service",
        id: "machines:split-one",
        changes: "records",
        runBy: "member",
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
        group: "service",
        id: "machines:make-unit-of",
        changes: "records",
        runBy: "member",
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
      {
        group: "service",
        // UI-SCREEN: /machines
        id: "machines:set-version-target",
        changes: "workspace",
        // ADMIN-ONLY: the target is what every machine in the cohort is judged against; the versions page offers it to admins alone.
        runBy: "admin",
        examples: ["our MK4s should all be on firmware 6.1.3", "set the Voron target to Klipper v0.12.0"],
        label: "Set the version a cohort should run",
        description: "Say which firmware and software version one cohort of machines (a model on one firmware family, such as Prusa MK4 · PrusaLink) should be on. The versions view then counts each machine in it as current, behind or unknown against it. Args: { cohort: the cohort's name as the versions view shows it, firmware_target?: string, software_target?: string }; an empty target clears it.",
        scope: "workspace",
        invokeHandler: "machines.set-version-target",
        userInvokable: true,
        argsSchema: {
          cohort: { label: "Cohort", type: "text", required: true },
          firmware_target: { label: "Firmware version", type: "text" },
          software_target: { label: "Software version", type: "text" },
        },
      },
    ],
  },

  subscribes: ["digifab.print.completed", "digifab.print.reversed", "digifab.device.versions_reported"],

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
  lifecycle: {
    onBoot: async () => {
      // What it shows on the dashboard, read in its one request (#6563).
      const { registerMachinesDashboardReads } = await import("./dashboard-reads.js");
      registerMachinesDashboardReads();
    },
  },
});
