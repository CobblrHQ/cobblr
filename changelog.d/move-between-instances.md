---
type: feature
scope: platform
date: 2026-08-09
docs_target: docs/USER_GUIDE.md#4.6 Moving records between instances
---
**Put something where it actually belongs.** A book on your Bookshelf that is really just inventory, or a kitchen item that wants its own "Cooking Stuff" list, can now be moved instead of deleted and retyped. The record keeps everything: its history, its tags, its photos, and the QR label already stuck on the thing.

## docs

**Filed it in the wrong place? Move it.** Open a record and choose **Move to...** from its ⋯ menu, or select several in a list and use **Move to...** in the bulk bar. Pick the destination and Cobblr shows you exactly what will happen before anything changes.

The record itself never changes identity. Its **printed QR label keeps working**, its history stays attached, and its tags, photos and service log come with it. Nothing is lost in either direction, because every list of the same type shares the same underlying shape: a kitchen item moved into a lean list keeps the cost you recorded even while that list stops showing a cost column, and moving it back shows it again.

**Custom fields.** If the record uses a field the destination does not have (a book's Author moving into Inventory), the preview lists it and offers to bring the field along, ticked by default. Untick it and the value is still kept on the record, just unlabeled, so nothing is deleted by unticking. Only fields the moved records actually use are offered, so moving one book does not add Author to everything in Inventory.

**What stays behind.** A destination's own setup is its own: saved views, field layout, label templates and code prefixes all belong to the list, not to the record, so a moved record adopts wherever it lands. Anything you have automated against the old list (a wire, a shared space) stops applying to that record, which is the point of moving it, and the preview says so when it applies.

**Move to...** appears only when another list of the same type exists. Moving between different *types*, such as a machine into Inventory, is not supported: those are different things rather than two lists of one thing.
