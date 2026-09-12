---
type: fix
date: 2026-09-12
---
Exporting a table to CSV now includes every field the table defines, not only the built-in columns: a bookshelf's file carries author, ISBN, year, reading status and rating. Importing that file back puts those fields where they came from, and an import started from a named table (a Bookshelf, a Pantry) lands on that table instead of the base inventory.
