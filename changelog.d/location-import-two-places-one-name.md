---
type: fix
scope: locations
date: 2026-09-30
---
Importing places from a CSV no longer scrambles a tree where two places share a name (a Shelf 1 in the Attic and another in the Basement): write the parent as its path, "Attic › Shelf 1", and each lands where its row says. A row that could mean two places is shown as blocked with the paths to choose from, the file imports only when every row is clear, and Export writes paths wherever a name repeats so the file imports back the same.
