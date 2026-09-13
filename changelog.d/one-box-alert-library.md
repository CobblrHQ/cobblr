---
type: internal
scope: ci
date: 2026-09-13
---
**One alert library for every box script.** The CI health tick and the scheduled-job wrapper on the app boxes post through the same `scripts/lib/box-alert.sh`: a red circle once per condition, a green "cleared" when it ends, a cooldown while it holds, any number of destinations from the webhook file, and an HMAC signature on non-Discord URLs so a listener can trust the sender.
