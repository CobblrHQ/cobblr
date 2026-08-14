---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
Cobblr now follows a tracked parcel on its own schedule, uses the carrier's date when it is better than the seller's estimate, and only asks you about an order when there is something to answer.

## docs

### How Cobblr decides when to ask

An order with a tracking number gets followed. Cobblr checks it about once a day
while it is still travelling, and three times on the day it is due, timed to
when parcels actually move: after the overnight run, mid morning when
out-for-delivery scans land, and in the evening when deliveries do. Once it is
out for delivery it checks that evening. Once it is delivered it stops checking
entirely.

That changes what you get asked, mostly by asking you less:

- **Still in transit on the day it was due?** No question. The estimate was
  wrong, and asking you about a parcel that is demonstrably still moving is
  noise.
- **Out for delivery?** One question that evening.
- **Delivered?** One question, quoting what the carrier said, so you know where
  to look before you answer.
- **No tracking number?** Unchanged: one question on the day it was due.

**A carrier never marks an order arrived.** "Delivered" means it reached your
doorstep, not that you have it and put it where you meant to, and only you know
the second one. Confirming is still yours.

### Which arrival date you see

Orders collect estimates from different places, and Cobblr keeps the best one:
the seller's estimate from a receipt, then the carrier's own date once it has
the parcel, then "out for delivery", then delivered.

A weaker source never overwrites a stronger one, and **a tracking number that
returns nothing never erases an estimate you already had**. A number typed in
before the seller has handed the parcel over reports nothing for a day or two;
that silence leaves your receipt's date exactly where it was.
