---
type: fix
date: 2026-08-11
scope: fields
---

A Member field showed a raw internal id instead of the person's name everywhere the value was displayed: table cells, list rows and the API. The picker was right, but everything that only reads the value was not.
