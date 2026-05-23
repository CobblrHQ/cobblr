// core-notifications — pluggable in-app + push notification engine.
// Foundational because every module that wants to tell the user
// something ("a part you ordered arrived", "your wire fired") goes
// through this module's dispatcher. Channel adapters (browser-push
// today; email, Discord, webhook stubbed in the contract) plug into
// a single subscriber registry.
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
  version: "0.1.0",
  displayName: "Notifications",
  description:
    "In-app + browser-push notifications, dispatched via a per-user-per-event subscription. Other channels (email, Discord, webhook) plug in via the channel-adapter contract.",
  icon: "bell",
  band: "foundational",

  intents: [],
  dependencies: [],

  exposes: {
    events: [
      "core-notifications.dispatched",
      "core-notifications.read",
    ],
    api: ["dispatch", "list", "markRead"],
    actions: [],
  },

  subscribes: [],
});
