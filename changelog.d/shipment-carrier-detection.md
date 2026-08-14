---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
Paste a tracking number on an order and Cobblr works out which carrier it belongs to, then links you straight to their tracking page.

## docs

### Tracking a parcel

An order has a **Tracking #** field. Fill it in and a **Shipment** panel appears
on the order, naming the carrier and linking to that carrier's own tracking page.

You do not pick the carrier. Every carrier's numbers have their own shape and a
check digit, so the number identifies itself. Cobblr recognises FedEx, UPS, USPS,
DHL, Amazon and OnTrac numbers, plus the S10 format used by national postal
services worldwide.

Because the check digit is verified rather than the shape alone, a mistyped
number is reported as unrecognised instead of being sent to the wrong carrier.
If you see "No carrier recognised this number", check it against the number in
your confirmation email first. Some carriers, and most international postal
services, are not recognised yet; the number stays on the order either way, so
nothing is lost.

An S10 international number is identified but gets no link, because that format
is shared by dozens of national postal services and the number alone does not
say which country to send you to.
