---
type: fix
scope: platform
date: 2026-08-25
---
**Notifications hold up better under load, and a Discord blip no longer silences everyone.** Three fixes to the delivery pipeline: a brief Discord outage (a restart, a timeout) during a busy moment used to mark every recipient's Discord link unverified at once, quietly cutting them off until each person reconnected; now only a genuine "this user cannot be messaged" does that, and a blip is retried. If you set one daily delivery time for both your activity and your dated reminders, both now arrive together instead of one of them silently slipping to the next day. And the digest sweep no longer sends a duplicate when two app instances overlap during an update.
