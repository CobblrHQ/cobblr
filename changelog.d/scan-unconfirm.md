---
type: feature
scope: scan
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-07-10
---
**A wrong commit is redoable.** Committed a scan into the wrong table, or as the wrong thing? The scan page's new **Recently committed** list has a **Send back** button: the scan returns to the pending inbox for you to fix and redo, and the entry it created is removed from its module. A scan that merely attached to an existing entry (add-quantity, link, move) never touches that entry when sent back. The mirror of Recently deleted: every scan decision now has an undo.

## docs

- **A wrong commit is redoable, not a dead end.** **Recently committed** at the bottom of the scan page lists recent commits with a **Send back** button: the scan returns to the pending inbox to fix and redo, and the entry it *created* is removed. A scan that merely *attached* to an existing entry (add-quantity, link, move) never touches that entry; the note reminds you to undo any quantity bump by hand.
