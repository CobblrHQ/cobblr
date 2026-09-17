---
type: fix
scope: scan
date: 2026-09-17
---
**A book whose title ends in a word like "parts" lands on the Bookshelf.** "JavaScript: The Good Parts", read by its ISBN with the category Books, was routed to the general Inventory table because its last word matched that table's name. The general table now yields to the table the catalog's category names.
