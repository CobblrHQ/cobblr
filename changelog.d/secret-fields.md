---
type: feature
scope: fields
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
docs_published: 2026-10-08
---
Added encrypted secret fields with permission checks and a history entry for every reveal or copy.

## docs

Choose **Secret** when adding a field for a licence key, password or PIN.
Saved values stay masked until you press **Reveal** or **Copy**. Each action
records who read the field without recording its value. **Change** replaces
it, and History says **updated** without either value.

Owners, admins and the record creator can reveal by default. A field read
scope replaces the creator default with its capability. Other members see
**hidden**. Shared copies and Cobb never receive secret values. Filter a
secret field by **has a value** or **is empty**.

Spreadsheets omit secret columns by default. An owner or admin can choose
**Include secrets**, and the export is recorded in History. Backups retain
values encrypted, with the key identifier. Restoring them requires the matching
encryption key. Blueprints carry the field definition without its value.
Ordinary spreadsheet downloads tell you that secret fields were left out.
Use an unused key when adding a secret field.
