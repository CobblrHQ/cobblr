// core-activity-log — append-only audit trail of every meaningful
// write across the platform. Foundational because almost every
// other piece of code logs through it (org creation, module enable/
// disable, wire fires, invite accepts, etc.).
//
// Implementation note: the activity_log table currently lives in
// cobblr_meta (the platform DB) because it's cross-tenant by design
// — admins need to see "what did this user do across all their
// workspaces?" without joining N tenant DBs. Per docs/design-
// decisions/build-plan.md "Deferred", a future migration may move
// the per-org slice into tenant DBs with a read-time UNION; for now
// this module's manifest just rebrands the existing platform code
// as module-owned so the kernel boundary stays honest.
//
// The implementation lives at api/src/platform/activity.ts +
// api/src/routes/activity.ts; the platform exposes it via
// platform().activity.log() to every module already. This module
// is the "official home" — a declaration of ownership.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-activity-log",
  version: "0.1.0",
  displayName: "Activity Log",
  description:
    "Append-only audit trail. Every meaningful write across modules (org changes, module enable/disable, wire firings, invites) lands here for visibility and forensics.",
  icon: "history",
  band: "foundational",

  intents: [],
  dependencies: [],

  // AI-REACH: no kinds/actions by design. The log is READ through the shared
  // registry's list_activity tool (who changed what, when) — an append-only
  // feed is not a record you create, update or delete, so an entity kind would
  // put a write surface on something nothing may write.

  exposes: {
    events: [],
    api: ["log"],
    actions: [],
  },

  subscribes: [],
});
