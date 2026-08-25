---
type: feature
scope: cadence
date: 2026-08-20
docs_target: docs/USER_GUIDE.md#3.25b Stock that reorders itself (purchases:draft-po)
---
**Your tables can now show how often you re-buy something, and how long what you have will last.** Cobblr has been learning both from ordinary shopping for a while, but the only way to see them was one item at a time. They are now field values, so you can put them in a table, sort by them, and see the whole cupboard ranked by what runs out first. Both stay blank until Cobblr has seen you buy the thing twice, because a guess from one shop would be made up.

## docs

### Consumption cadence

Cobblr learns how fast you go through the things you re-buy, without you logging anything. Every time you check an item off a shopping list, that is recorded as a purchase, and the gaps between those purchases are the signal.

Two values come out of it, and any table can show them:

| Field | What it means |
|---|---|
| **You re-buy every** | The typical number of days between your purchases. "You re-buy this every 23 days." |
| **Runs out in** | Days until the current stock is gone, at the rate you have been going through it. |

Both are blank until Cobblr has seen at least two purchases. One shop is not a pattern, and a fabricated date is worse than an honest blank. A third and fourth purchase move the reading from "still learning" to a figure you can rely on.

They are deliberately two different numbers. How often you re-buy does not depend on pack size; how long stock lasts does. Buying one 80-bag box of tea a month and two 40-bag boxes a month are the same habit but different quantities, and only one of the two columns should move.

To put them on a table, add a field of type **computed** and use `{{ cadence.replenish_every_days }}` or `{{ cadence.days_until_runout }}` as the template. The Spice Rack and Tea bundles ship with both columns already on their views.
