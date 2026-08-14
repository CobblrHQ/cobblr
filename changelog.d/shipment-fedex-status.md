---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
Connect FedEx and an order with a tracking number shows where the parcel actually is, with its scan history.

## docs

### Following a parcel, not just linking to it

Naming the carrier needs no setup. Following the parcel needs that carrier's
API, so you connect the ones you use. Tracking APIs are free to call, so this
costs nothing per parcel.

**FedEx.** Create a project at `developer.fedex.com` and choose **Basic
Integrated Visibility**, which is their tracking product. The project's API Key
and Secret Key go in your instance's environment:

```
COBBLR_FEDEX_API_KEY=...
COBBLR_FEDEX_SECRET_KEY=...
COBBLR_FEDEX_ENV=production
```

Register as yourself, tracking your own shipments. Test keys answer only for
FedEx's own sample numbers and return the same fixture for every number, so set
`COBBLR_FEDEX_ENV=sandbox` while you are trying it out and switch to
`production` once the project is live.

Once connected, the Shipment panel on an order shows the current state, the
carrier's own wording for it, where it last was, the expected delivery day, and
the full scan history behind a toggle.

The states are deliberately plain: Label created, In transit, Out for delivery,
Delivered, Needs attention, No information yet. "Needs attention" covers the
cases where a parcel is stuck waiting on you, such as one held for collection.

If a carrier is not connected, or Cobblr has no integration for it yet, the
panel says which of those it is. The tracking link keeps working either way.
