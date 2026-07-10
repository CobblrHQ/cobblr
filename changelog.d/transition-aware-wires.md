---
type: improvement
scope: automations
date: 2026-07-03
---
Automations can now fire **only when a field actually changes**, not on every edit. A wire condition can compare two live values: e.g. `{{event.after.location_id}}` vs `{{event.before.location_id}}`, so "when status changes to Done, notify" runs on the transition, not every time the row is saved while it merely *stays* Done. Entity updates now carry a before/after snapshot for this. Groundwork also lands for **server-managed fields** (values the server owns and stamps, which a client write can never overwrite), the foundation for upcoming home-vs-current location tracking.
