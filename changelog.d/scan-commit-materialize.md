---
type: fix
scope: scan
date: 2026-06-21
---
Filing a scanned item into a category whose module isn't set up yet no longer dead-ends on a cryptic "Target create returned 409". Committing a scan now **enables the target module automatically** (e.g. Inventory) and files the item — the capture-first "scan first, structure later" promise. And if a commit genuinely can't go through, you now see the **real reason** (e.g. "Enable Inventory in Configuration → Modules") instead of a bare status code.
