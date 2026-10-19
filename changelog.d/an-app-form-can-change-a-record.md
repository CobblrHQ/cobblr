---
type: feature
scope: core-apps
date: 2026-10-17
docs_target: docs/user-guide/apps.md#3.15 Apps (`core-apps`, stock)
ui: none (the app builder's form block gains a choice between adding and changing a record, and the app player shows the change form)
docs_published: 2026-10-19
---
A form in a worker app can now change an existing record, not only add one: pick a part, an asset or a project, correct its name, place or other fields, and save. The form offers only the fields you can see and may change, the record's history shows the change, and the assistant can make the same change by asking.

## docs

**Changing a record from an app.** In **Configuration → Apps**, a form block can be set to **Change an existing record**. A member opening the app finds the record, sees its values, changes some and presses **Save changes**. Only the fields they can see and may change are offered, so a field hidden from them (a part's cost) is neither shown nor saved, and they need the same permission the record's own page asks for. A part's count is not edited here; it moves through the stock actions. The change appears in the record's history, and the assistant can make the same change by asking.
