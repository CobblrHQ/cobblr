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

### Using your own tracking account instead

The settings above belong to whoever runs the server, which is the right answer
when that is you. On a Cobblr you do not run, it is not: you would be asking an
operator to put your key on their box.

So a tracking service can also be a **personal connection**. Under **Profile >
Connections**, add a Parcel tracking connection with your own key and choose
which workspaces it applies to. Your parcels are then followed with your
credentials and billed to your account, in every workspace you routed it to.

Your own connection wins wherever you have one. Where you do not, whatever the
instance is configured with still applies, so a self-hosted box keeps working
exactly as before with nothing to change.

Two things follow from a connection belonging to a person rather than a
workspace:

- **Just me** means your own parcels use it. **Share** offers it to the whole
  workspace, and its owner has to accept before anyone else's parcels use it.
- If your tracking service runs on your own network, set transit to `bridge` and
  it rides **your** edge bridge, whichever workspace the parcel is in. One bridge
  serves all of them.
