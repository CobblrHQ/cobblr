---
type: feature
scope: builds
date: 2026-10-17
docs_target: docs/USER_GUIDE.md#3.25 Builds (light bill-of-materials)
docs_published: 2026-10-18
---

A build takes sub-assemblies from stock before making more

## docs

**Sub-assemblies from stock first.** When a build uses a sub-assembly that you also keep in stock, a run takes the stocked ones first and makes only the rest. Building 3 printers with 2 controller boards on the shelf uses those 2 and makes 1, so the shortfall lists only the parts for that 1 board. Each sub-assembly line on the build page shows how it is met for the quantity you are building ("2 from stock, 1 to make"). Press **Use stock first** on the line to switch it to **Always make**, which makes every one from its parts and leaves the stock alone.
