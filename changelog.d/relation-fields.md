---
type: improvement
scope: fields
date: 2026-07-03
---
Fields can now **reference another record**. A new `relation` field type stores a link to another entity (e.g. a location) and renders it as that record's name — the "link to another record" building block. Lists, tables, search, and the generic entity API all show the referenced name instead of an id. First used by the upcoming home-vs-current location tracking; a general-purpose picker in the field builder follows.
