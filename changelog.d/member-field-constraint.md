---
type: fix
date: 2026-08-11
scope: fields
---

Creating a Member field failed with a database error. The type was accepted everywhere in the application and rejected by the database itself, so the field could never actually be saved.
