---
type: fix
scope: platform
date: 2026-09-28
---
Saving a record with a field name its type doesn't have is now refused, with a list of the fields it does have and a "did you mean" when one is close, instead of quietly storing the value where no form shows it. This applies to scripts, the API and AI assistants alike. AI assistants also now see workspace-wide fields, such as a provenance field on every physical thing, on each record type they apply to.
