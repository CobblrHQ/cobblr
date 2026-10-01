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
  version: "0.1.4",
  displayName: "Notifications",
  description:
    "Get told about what matters to you, in the app and through the channels you choose.",
  icon: "bell",
  band: "foundational",

  dependencies: [],

  // AI-REACH: no kinds/actions by design. Read through the shared registry's
  // list_notifications tool. A notification is delivered TO a person, never
  // authored by one, so there is nothing for an agent to create or edit.

  exposes: {
    events: [],
    actions: [],
  },

  subscribes: [],
});
