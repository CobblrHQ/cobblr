---
type: improvement
scope: scan
date: 2026-06-21
---
When you scan a maker's product QR (e.g. a Polar Filament spool), Cobblr fetches the maker's data and fills in the real product, and that vendor list is now **data you can edit**, not code. A new **Scan Resolvers** page in the operator console lets you add a maker by describing how to read its URL (match → fetch → map fields), test it against a real URL, and edit or disable built-ins, no deploy. Adding the next maker is a list entry, not a code change. (Replaces the old single-vendor maker-scan module; the built-in Polar resolver behaves identically.)
