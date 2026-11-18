---
type: fix
scope: sales
date: 2026-11-18
docs_target: none (the user guide and the sales module doc say it in this commit)
---
Following the parcels you send now follows every parcel of an order, not only the last one: the first boxes of an order sent in parts are watched too, each shows when it was delivered, and the order is delivered only when all of them are.
