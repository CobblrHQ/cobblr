// core-notifications — pluggable notification engine: in-app, and the channels a person routes to.
// Foundational because every module that wants to tell the user
// something ("a part you ordered arrived", "your wire fired") goes
// through this module's dispatcher. Channel adapters (in-app, email,
// Discord, Slack, SMS, a webhook; browser push is a stub, not offered)
// plug into a single subscriber registry.
//
// Implementation note: like core-activity-log, the storage is in
// cobblr_meta (notifications + notification_subscriptions tables)
// because subscriptions are per-user across workspaces. A future
// migration may slice this into tenant DBs. For now the manifest
// rebrands the existing platform code as module-owned so the
// kernel/module boundary stays honest.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-notifications",
  version: "0.2.0",
  displayName: "Notifications",
  description:
    "Get told about what matters to you, in the app and through the channels you choose.",
  icon: "bell",
  band: "foundational",

  dependencies: [],

  // AI-REACH: no kinds by design. Notifications are read through the shared
  // registry's list_notifications tool. The one thing a person authors here
  // is a message an automation sends (message-someone, #6070), which is an
  // action the assistant reaches like any other.

  exposes: {
    events: [],
    notifications: [
      {
        eventType: "core-notifications.message",
        label: "A message from an automation",
        description: "An automation in your workspace asked to tell you something, like a thing running out that needs buying.",
      },
    ],
    actions: [
      {
        group: "more",
        id: "core-notifications:message-someone",
        runBy: "member",
        label: "Message someone",
        description:
          "Send a short message to a person in the workspace through their own notification channels (in the app, push, email, Discord, as they chose). The message may use the record's fields ({{name}}, {{quantity}}, {{unit}}) and {{event.actor.display_name}}; left empty it says the record is used up and asks for more. Wire it to a record running out to ask someone to get more.",
        examples: ["tell Sam when the coffee runs out", "message me when we are out of milk"],
        // DELIBERATELY universal: anything a workspace keeps can be the
        // subject of a message, and the record only fills the words.
        appliesTo: { any: true },
        invokeHandler: "core-notifications.message-someone",
        argsSchema: {
          to: { label: "Who", type: "text", required: true, choicesFrom: "people" },
          message: { label: "What to say (empty: “<name> is used up. Could you get more?”)", type: "text" },
        },
        userInvokable: false,
      },
    ],
  },

  subscribes: [],

  api: () => import("./api/index.js"),
});
