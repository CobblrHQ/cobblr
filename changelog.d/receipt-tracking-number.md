---
type: feature
scope: purchases
date: 2026-08-14
docs_target: docs/USER_GUIDE.md#3.25c Reading a purchase order
---
Add a tracking number to a receipt while it is still in your scan inbox, and Cobblr files it as still on its way instead of already arrived.

## docs

### Adding a tracking number to a receipt

A receipt that lands in your scan inbox is where you first see a purchase, so it
is where you can record the parcel's tracking number. The receipt's header row
carries one parcel control (the truck): it shows the best thing known about the
parcel - the carrier's state once it is followed, the receipt's own "arriving
tomorrow" estimate when there is a promised date, and **+ Tracking #** when
neither exists yet. Tap it to add or edit the number.

This changes how the receipt is filed. Without a tracking number or a future
promised date, Cobblr records the order as arrived, because most receipts are
for something already in your hands. With one, it records the order as **in transit** and leaves the arrival
date empty, because nobody issues a tracking number for something you already
have.

That distinction is what makes the parcel get followed. Cobblr only watches
orders that have not arrived, so a receipt filed as arrived would carry the
number and never check it.

Once filed, the number lives on the order as **Tracking #**, where you can edit
it like any other field, and the shipment panel on that order shows where the
parcel is.
