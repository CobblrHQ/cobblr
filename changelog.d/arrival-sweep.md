---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
An order with an expected arrival date now asks you whether it turned up, on the day it was due, instead of sitting open forever.

## docs

### "Did it turn up?"

Give an order an **Expected arrival** date and Cobblr takes it from there. On
the day it was due, if nothing has marked the order arrived, you get one
notification naming the vendor and asking whether it turned up. Opening it takes
you to the order, where **Mark arrived** is a single button.

Marking an order arrived does the rest: it stamps the arrival date, and every
line linked to an inventory part releases its stock receipt, so what you bought
lands in your counts without you typing it in twice.

**It asks once.** If you do not answer, there is one follow-up three days later,
and then it goes quiet. Cobblr does not repeat a question you have already
declined to answer twice.

If the seller pushes the delivery date back, change **Expected arrival** and the
question resets to the new date. Marking an order arrived, or cancelling it,
stops the asking immediately.

Orders with no expected arrival date are never asked about, so this costs
nothing on the orders you do not care to track.
