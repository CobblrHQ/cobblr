---
type: feature
scope: purchases
date: 2026-08-13
docs_target: docs/USER_GUIDE.md#Purchases
---
A tracking service running on your own network can now be reached through your edge bridge, so hosted Cobblr can follow parcels it could not otherwise see.

## docs

### If your tracking service runs at home

Cobblr on the web cannot reach an address on your home network, and no setting
changes that: private addresses are blocked and your router would stop it
anyway.

So tell Cobblr to go the long way round, through the edge bridge you already
run:

```
COBBLR_TRACKING_API_TRANSIT=bridge
```

Your bridge makes the call on its own network and passes the answer back. Use
`bridge:<id>` if you run more than one and want a specific one.

Leave it unset for a public tracking service, which is reached directly.
