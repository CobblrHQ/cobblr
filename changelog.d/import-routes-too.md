---
type: fix
scope: scan
date: 2026-08-24
---
Importing a scan inbox no longer leaves every item stuck under a "finishing"
spinner. Imported scans are marked as identified, which they already were when
they were exported, so they arrive ready to file instead of appearing to still
be working.
