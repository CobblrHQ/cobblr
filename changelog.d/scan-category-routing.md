---
type: feature
scope: core-scan
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Things of the same kind stop scattering across your tables.** Scan five electrical parts and they used to land in four different places: one in Home Inventory, one in Household Supplies, one in Inventory, one in Maker Workshop. That was not really the AI being dim. It was being asked which table an item belonged in, when the only tables on offer all meant roughly "stuff", and it was asked separately for each item, so identical things went to different homes. Tables now carry a **Category** field, and a difference in *kind* is recorded there rather than by picking a different table. A vehicle is still not a part, so those stay separate tables. But an electrical part and a plumbing part are the same kind of record, so they live in one table and are told apart by their category. Anything the scanner cannot confidently place lands in a table you nominate as your catch-all, tagged with its category. The categories are yours: the list starts empty, grows only from values you actually confirm, and near-misses snap onto the value you already use rather than quietly creating a second spelling of it. This works with the AI switched off, too, since the identification step already worked out a category and it was previously being thrown away.

## docs

### Categories: how the scanner tells a wall plate from a rocker switch

Scan five electrical parts and they used to land in four different tables. That was not really the AI being dim. The only question it could answer was *"which table does this go in?"*, the tables on offer all meant roughly "stuff", and it was asked separately for each item, so identical things went to different homes.

A table can now carry a **Category** field, and a difference in *kind* is recorded there instead of by picking a different table:

> A vehicle is not a part, so those stay separate tables. But an electrical part and a plumbing part are the same **kind of record**, so they live in one table and are told apart by their **category**.

**The categories are yours.** The list starts empty. It grows only from values you actually confirm, so the vocabulary is the one you use rather than one Cobblr shipped. And a near-miss snaps onto the value you already have: confirm `Electrical` once, and a later scan proposing `electrical` will reuse yours rather than quietly creating a second spelling beside it.

When the scanner cannot confidently place an item, it goes to the table you nominate as your **catch-all**, tagged with its category. Pick one in an instance's settings; until you do, it uses the module's default table.

If nothing in your existing list fits, the card **proposes** a new category. Nothing is created until you confirm, and confirming is what adds it to the list for next time.

This works with AI switched off, too. Identifying an item already worked out a category, and that was previously being thrown away.

Later on, a category that outgrows the catch-all (enough items, or enough fields of its own) can be **promoted into a table of its own**.
