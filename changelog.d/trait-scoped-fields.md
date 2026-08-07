---
type: feature
scope: platform
date: 2026-07-13
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
docs_published: 2026-08-07
---
**A custom field can now apply to *all physical items*, not just one kind.** Say you want to track where something came from: FB Marketplace, a gift, bought new. That question is the same for a part, a machine, a vehicle, a whole room. Until now you had to create the same "Origin" field once per kind, and create it again by hand every time you started tracking a new kind of thing. On the `/fields` page, the destination picker now offers **All physical items** (and All digital items) above the list of individual kinds. Pick it, and the field lands on everything physical you track: parts, assets, machines, vehicles, locations. Anything physical you add later gets it automatically, with nothing to redo. If you want it worded differently on just one kind, add a field with the same name to that kind and the more specific one wins.

## docs

A field def can be attached to **one entity kind**, or to a **whole class of them**.

In the `/fields` destination picker, above the list of individual kinds, sits **A whole class of things**:

- **All physical items**: anything you can hold, store, or point at. Parts, assets, machines, vehicles, locations.
- **All digital items**: things with no physical body. Records, documents, entries.

Pick one of those instead of a kind and the field is created **once** and appears on every kind that qualifies. This is not a bulk-copy: nothing is duplicated per kind. The field is matched against each kind's declared nature, so a kind you start tracking **next month** inherits the field automatically, with nothing to redo. That is the point of it: "where did I get this?" is a question about physical things in general, not about parts specifically.

The `/fields` list shows a scoped field once, under its class rather than under a kind. Opening it says which class it belongs to and warns that editing or deleting it changes it everywhere it appears.

**Overriding it on one kind.** If the workspace-wide field is *almost* right but you want it labelled differently (or with different dropdown choices) on a single kind, add a field with the **same name** to that kind. The more specific one wins there, and the class-wide one keeps applying everywhere else.
