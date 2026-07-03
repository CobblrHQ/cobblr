// core-devices — the device substrate. A *capability* (ambient plumbing, no nav
// noun): connections, the driver registry, egress, the actuator + inbound
// ingest, and the device → entity links live here so every device-touching
// consumer (digifab fabrication, core-print, the smart-shelf / irrigation
// bundles) sits on ONE substrate instead of overreaching `digifab`.
// See docs/architecture/core-devices-extraction.md.
//
// PR 1 ships only the device → entity LINK; connections/drivers/actuator/ingest
// migrate here in subsequent PRs.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-devices",
  version: "0.2.0",
  displayName: "Devices",
  description:
    "The device substrate — link a physical device (a scale, an RFID reader, a relay) to the Cobblr thing it feeds, in one place. Plumbing under digifab, core-print, and the edge-firmware connector.",
  icon: "cpu",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace, no nav noun

  schema: {
    tablePrefix: "core_devices_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    // Inbound device events (chip → Cobblr; moved here from digifab). A wire — or
    // the ingest path's link resolution — turns these into entity actions.
    events: [
      "core-devices.device.reading",
      "core-devices.device.scanned",
      "core-devices.device.counted",
      // The actuator ack (moved here from digifab.command.sent).
      "core-devices.command.sent",
    ],
    api: [],
    actions: [
      {
        id: "core-devices:apply-to-linked-entity",
        label: "Apply a device event to its linked entity",
        description:
          "Resolve a device's (connection, device) link to a Cobblr entity and perform the link's mode by invoking the entity-owning module's action (e.g. a scale reading → inventory:set-stock). Wire-driven; the ingest path applies it automatically when a link exists. Reads the device payload from the event.",
        // DELIBERATELY universal: fires on DEVICE events (inbound ingest) where
        // the wire's source kind is irrelevant — the handler self-locates the
        // linked entity. Scoping by kind/trait here would be false precision.
        appliesTo: { any: true },
        invokeHandler: "core-devices.apply-to-linked-entity",
        userInvokable: false,
      },
      {
        id: "core-devices:run-command",
        label: "Run a device command",
        description:
          "Fire a parameterized command-and-forget at a connected actuator/controller — open a valve for N seconds, call a Home Assistant service, flip a relay. Wire-invokable: an entity's schedule (e.g. each plant's water_rrule) commands a device with THAT entity's own params. `connection` + `command` are fixed wire args; the rest pass through as the command's params. Reaches the device via platform().devices.getDriver — works for any connection kind (digifab fabrication drivers, edge-adapter, etc.).",
        // Physical things command devices (a plant waters, a part reorders
        // ink). Trait-scoped so "Run a device command" stops offering itself
        // on subscriptions and tasks; a workspace can broaden it per-axis on
        // /actions if their use genuinely differs (that page exists for this).
        appliesTo: { traits: ["physical"] },
        invokeHandler: "core-devices.run-command",
        userInvokable: false,
      },
    ],
  },
});
