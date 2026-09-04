---
type: fix
scope: core-scan
date: 2026-09-02
---
Scanning a book with a Bookshelf table installed now files it into the Bookshelf instead of the general catch-all. Routing used to take its strongest signal from the item's title alone, and a title is the one place a book never says it is a book: an ISBN scan came back categorised "Books" and still landed in Inventory. When the identified category names a table (a "Books" category and a table of books), that table is now the answer. A category that names no table still lands in the catch-all and is told apart by its category, as before.
