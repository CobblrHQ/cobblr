---
type: feature
scope: bundles
date: 2026-08-24
docs_target: docs/USER_GUIDE.md#3.18 Module instances ("+ New category")
---
Groceries is now its own table rather than extra columns on Inventory, so a
scanned cucumber and a scanned bolt no longer share a list. Groceries, Tea and
Spices sit together under one Kitchen heading in the nav, and Tea and Spices
now reach the shopping list when they run low, which they previously did not.
Anything already filed into Inventory stays exactly where it is and keeps all
its columns.

## docs

Groceries, Tea and Spices are three tables under one Kitchen heading. Each
holds its own things with its own columns: a spice jar has an opened-vs-sealed
state, a tea has a box count, a grocery has an expiry.

All three behave the same way underneath, because all three are stock: a
quantity you draw down, a re-buy point, a shopping list that fills itself when
something runs low or is about to go off, and a cadence that learns how often
you actually re-buy.

If you used Groceries before this, what you already filed stays in Inventory
with all its columns intact. New scans route to the Groceries table, and an
item sitting in the scan inbox will offer the better table when one exists.
