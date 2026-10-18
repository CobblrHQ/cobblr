// core-integrations — outbound + inbound external connectors.
//
// Two halves:
//   - Outbound: Slack/Discord/webhook/email (more to come) — fired by
//     wires that match an entity event to a connector + action.
//   - Inbound: workspace gets a stable webhook URL per connector;
//     incoming POSTs are validated, dispatched to a registered
//     handler, and emitted as platform events that the rest of the
//     module surface can subscribe to.
//
// See docs/modules/core-integrations.md.
//
// Stock band. Built-in connectors register at module load — the
// registry lives in the platform layer, so additional connectors can
// be added from other modules without modifying this one.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-integrations",
  version: "0.2.4",
  displayName: "Integrations",
  description:
    "Connect your workspace to Slack, Discord, email and other services, sending and receiving updates as things happen.",
  icon: "plug",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_integrations_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: no kinds by design. A connector holds CREDENTIALS for an outside
  // service, so creating or editing one is deliberately not agent-writable.
  // What a person does to one that carries no secret (sync now, switch a
  // section, archive, test) is an action below. Sending through a connector is
  // a service (services.ts, invoke_service). The wires built on top are read
  // through get_workspace_setup (part: "automations").

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-integrations.connector.created",
      "core-integrations.connector.updated",
      "core-integrations.connector.deleted",
      "core-integrations.connector.invoked",
      "core-integrations.connector.failed",
      "core-integrations.inbound.token.created",
      "core-integrations.inbound.token.revoked",
      "core-integrations.inbound.received",
      "core-integrations.sync.received",
    ],
    actions: [
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:sync-now",
        changes: "records",
        runBy: "member",
        examples: ["sync my shop now", "pull the latest orders from the store"],
        label: "Sync now",
        description:
          "Run a connected source's sync for one section right away instead of waiting for its next turn, after its first import has been approved. Says what changed.",
        scope: "workspace",
        invokeHandler: "core-integrations.sync-now",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
          section: { label: "Which section it syncs (products, orders, …)", type: "text", required: true },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:set-sync",
        // ADMIN-ONLY: the page's own route PUT /sync/connections/:id/syncs/:entityType is owner or admin (sync.ts)
        runBy: "admin",
        examples: ["stop syncing the shop's products", "sync the orders every 15 minutes"],
        // Not undoable: switching a sync on starts writes from outside that an Undo could not take back, so it always asks first.
        label: "Turn a sync on or off",
        changes: "workspace",
        description:
          "Turn live sync for one section of a connected source on or off, and how often it runs. Live sync starts only after the section's first import has been approved.",
        scope: "workspace",
        invokeHandler: "core-integrations.set-sync",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
          section: { label: "Which section it syncs (products, orders, …)", type: "text", required: true },
          enabled: { label: "true to sync it, false to stop", type: "boolean", required: true },
          cadence_min: { label: "Every how many minutes (1 to 1440; empty keeps the default)", type: "number" },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:archive-sync-connection",
        changes: "workspace",
        // ADMIN-ONLY: the page's own route POST /sync/connections/:id/archive is owner or admin (sync.ts)
        runBy: "admin",
        examples: ["archive the old shop connection"],
        undoable: true,
        label: "Archive a connection",
        description:
          "Move a connected source to the history list and stop its syncing. Nothing is deleted: its settings and what it brought in stay, and it can be brought back.",
        scope: "workspace",
        invokeHandler: "core-integrations.archive-sync-connection",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:unarchive-sync-connection",
        changes: "workspace",
        // ADMIN-ONLY: the page's own route POST /sync/connections/:id/unarchive is owner or admin (sync.ts)
        runBy: "admin",
        examples: ["bring the old shop connection back"],
        undoable: true,
        label: "Bring a connection back",
        description: "Bring an archived connected source back to the list. Its syncing stays off until someone turns it on again.",
        scope: "workspace",
        invokeHandler: "core-integrations.unarchive-sync-connection",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:test-sync-connection",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /sync/connections/:id/test is owner or admin (sync.ts)
        runBy: "admin",
        examples: ["is the shop connection still working"],
        label: "Test a sync connection",
        description:
          "Check that a connected source still answers with the credentials stored for it, and say what it said. The credentials themselves are never shown.",
        scope: "workspace",
        invokeHandler: "core-integrations.test-sync-connection",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /configuration/integrations
        id: "core-integrations:test-connection",
        changes: "records",
        runBy: "member",
        examples: ["check the Slack connection works"],
        label: "Test a connector",
        description:
          "Check that an outgoing connector (Slack, Discord, a webhook) still accepts the credentials stored for it, and say what it said. The credentials themselves are never shown.",
        scope: "workspace",
        invokeHandler: "core-integrations.test-connection",
        userInvokable: true,
        argsSchema: {
          connector: { label: "Which connector (its name)", type: "text", required: true },
        },
      },
    ],
  },

  subscribes: [],
});
