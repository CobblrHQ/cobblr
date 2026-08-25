---
type: feature
scope: kitchen
date: 2026-08-25
docs_target: docs/USER_GUIDE.md#3.18 Module instances ("+ New category")
---
The dashboard now offers to move items into the table they look like they
belong in: food filed in plain Inventory before the Groceries table existed
gets a one-press "Move N to Groceries" card, and nothing ever moves without
that press. The Groceries table also gains the two re-buy views Tea and Spices
already had, and fresh installs get one pinned "What's on hand" instead of a
second, permanently empty copy.

## docs

If you were tracking food in plain Inventory before the Groceries table
existed, the dashboard shows a card counting the items that look like they
belong there, with one button to move them. The signal is the fields a row
carries: something with an expiry or a food category looks like Groceries,
something with a caffeine level looks like Tea. Ambiguous rows are left alone,
and nothing moves until you press the button. The same offer works for any
table you add later.
