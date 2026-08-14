---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
Connect a tracking service and Cobblr can follow parcels from any carrier, including ones it has no built-in support for.

## docs

### Following a carrier Cobblr has no driver for

Carrier APIs each need their own signup and several need a payment method, which
puts live tracking out of reach for most carriers. So Cobblr also speaks a
general tracking API, and it separates **which wire format** from **which
endpoint**, the same way its AI providers work.

```
COBBLR_TRACKING_API=easypost                        # the wire format
COBBLR_TRACKING_API_URL=https://api.easypost.com/v2 # where it lives
COBBLR_TRACKING_API_KEY=...                         # the key
```

Set the key and every carrier Cobblr recognises becomes followable, not just the
ones with a built-in driver. EasyPost's format is the default because it prices
per parcel with no monthly minimum, so a handful of packages costs cents.

Where you have configured a carrier's own API, that wins: it is first-hand,
where a tracking service is a third party reading the same data.

**The URL is a separate setting on purpose.** Anything that answers the same
shape works, including something you run yourself. Cobblr cannot tell the
difference and takes no position on what is behind that address.
