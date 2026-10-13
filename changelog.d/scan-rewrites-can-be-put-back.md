---
type: fix
scope: core-scan
date: 2026-10-12
docs_target: none (documented directly in USER_GUIDE.md and docs/modules/core-scan.md)
---
A lookup that renames a scanned item wrongly can now be undone. The "Lookup updated" toast has Undo, and every step in the item's History that changed it has Put back, which restores the name, brand, barcode, pictures and kind together. History says what each step changed in plain words ("Looked up again: name changed from … to …") and lists a step that changed nothing once. The assistant can do the same with put_back_scan_item.
