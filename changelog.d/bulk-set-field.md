---
type: feature
scope: inventory
date: 2026-10-03
docs_target: docs/USER_GUIDE.md#3.1 Inventory
docs_published: 2026-10-08
---
Selected records can now have a built-in or custom field set or cleared together, with skipped rows named and one Undo for the batch.

## docs

Tick the records you want to change, then choose **Set field…** on the selection bar. Pick a built-in or custom field, enter its new value, or choose **Clear this field**, then apply it to the selection. The picker offers writable fields that every selected kind has. Stock counts keep their own counting controls.

Every successful row keeps its own history entry. A row that cannot be changed is skipped and listed with its reason, while the other rows are saved. **Undo** on the toast restores all successful rows together. A field you corrected after the batch keeps its newer value when you undo, and is listed as skipped. This control is available to workspace owners, admins and editors on inventory, assets, machines, places, projects, purchases and table views. Cobb and MCP can run the same batch action and undo it together.
