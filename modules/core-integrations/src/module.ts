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
  version: "0.1.0",
  displayName: "Integrations",
  description:
    "Connect your workspace to Slack, Discord, email, and any service with a webhook. Fire on entity events, receive external pings.",
  icon: "plug",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_integrations_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

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
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
