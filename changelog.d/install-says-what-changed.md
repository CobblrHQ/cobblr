---
type: feature
scope: bundles
date: 2026-08-22
docs_target: docs/USER_GUIDE.md#Install a bundle
---
Installing a bundle now tells you what it changed and where it went, including when it adds to a table you already have instead of making one of its own.

## docs

Bundles come in two shapes, and only one of them puts something new in your nav.

Some bundles bring their own table. Install one and you get a new entry in the
nav, with its own items and its own fields.

Others add to a table you already have. A grocery bundle, for example, does not
create a Groceries section: it adds fields like Expires and Storage to the parts
in your Inventory, and sets up automations between them. Nothing new appears in
the nav, because there is nothing new to appear.

That used to make a successful install look like a failed one. Now the install
tells you which kind it was and what it did:

> Groceries is set up. It adds to Inventory rather than making a table of its
> own, so there is no new entry in the nav.
>
> - 4 fields on Inventory (*Open Inventory*)
> - 6 automations, which run on their own (*See the wires*)

Each line links to where that part of it lives. Fields go to the table they were
added to; automations go to **Wires**, where you can see each one, what triggers
it, and when it last fired.

When you install from a scan card while filing items, the same summary appears
as a short message instead, so it does not interrupt what you were doing.
