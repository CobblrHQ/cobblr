---
type: selfhost
scope: scan
date: 2026-08-09
---

Vendor lookups now identify your instance instead of ours. When you scan a maker's QR code, the request carries the contact address you set in `COBBLR_OPERATOR_EMAIL` (or your first superadmin address), so the vendor can reach you about your own traffic. Until now every install sent the same address and the same site URL, belonging to whoever publishes Cobblr, which meant a vendor could not reach the person actually calling. With no contact address configured, a lookup that requires one is skipped and says so in the log, rather than going out under someone else's name.
