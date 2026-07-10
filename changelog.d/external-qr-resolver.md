---
type: improvement
scope: scan
date: 2026-06-20
---
Groundwork for reading QR labels printed by other apps. The scanner can now be taught (per workspace) how to map a foreign QR code (a companion app URL, a bare Homebox number, …) to the matching Cobblr item, so labels you already printed keep working without a reprint. When a rule matches, the scan behaves exactly like a native one (opens the item). Opt-in and invisible until you set up a rule. The point-and-click setup lands next; today it's configurable via the API.
