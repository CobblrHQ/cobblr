---
type: feature
date: 2026-09-20
scope: scan
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-09-23
---

Forward a store's shipping emails to your receipt address and your parcels track themselves, with nothing to type. Amazon's "Shipped", "Arriving today" and "Delivered" emails are read as the tracking events they are, matched to the order they belong to, and announced the same way a carrier update is, so a delivery is a card in your DMs within seconds of the store's email. A shipping notice that arrives before its order confirmation opens the parcel on its own; the confirmation reads into it later. Returns are read the same way: a store's return request, drop-off and refund emails are recorded on the order they came from and announced as they happen, so a refund on its way is a card, not a search through your inbox. A cancellation is recorded too: one that covers the whole order stops it being watched for an arrival, and an order that was only ever waiting for its receipt is removed rather than left waiting. A mail rule does the forwarding, and the one email that used to defeat the setup, your mail provider's forwarding confirmation, is relayed to your own inbox so you can click it. A store's promotions that the rule forwards along with the rest are dropped rather than filed.

## docs

Add to the receipts-by-email section: a mail rule forwarding a store's order and shipping emails to the receipt address is all the setup there is. Gmail: Settings, Filters, create a filter for `from:(amazon.com) subject:(shipped OR arriving OR delivered OR ordered)`, action "Forward to" the receipt address (add `OR "return request" OR "dropoff confirmed" OR "refund issued" OR cancelled` to the subject list to have returns and cancellations follow); Gmail then sends a confirmation to that address, which Cobblr relays back to your own inbox to click. Shipping notices with no order confirmation yet appear in the scan inbox as a receipt "awaiting the receipt", already tracked.
