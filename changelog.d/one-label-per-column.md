---
type: fix
scope: bundles
date: 2026-08-24
---
An inventory table no longer shows two columns both headed Category. The
groceries bundle's own category field had been given the same label as
Inventory's built-in one, so both were drawn and neither said which was which.
On the Groceries table the built-in one is now hidden, since the food category
replaces it; on plain Inventory the grocery one reads "Food category".
