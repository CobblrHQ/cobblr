---
type: fix
scope: platform
date: 2026-07-18
---
**Features that read one record inside a named collection now work.** A collection like a Bookshelf or a Vehicles list registered how to LIST its records but not how to read a single one, so anything that looked up an individual record got nothing back, silently. The visible symptom was fetching a cover: it refused with "these need a name first" for books that plainly had names. Four modules had the gap (records, assets, machines, projects) and all four are fixed, so per-record features work inside every named collection. The bulk fetch also stops blaming your data for a bug on our side, and a new CI check makes it impossible to register one half of the pair without the other.
