---
type: feature
scope: inventory
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.1 Inventory
docs_published: 2026-10-08
---
Added component package receiving from distributor labels, moisture exposure tracking, bake timers and placement counts with attrition.

## docs

Install **Electronics assembly** from the bundle catalog. Component Parts holds manufacturer part numbers, and Component Packages holds each physical reel, cut tape, tray or tube with its own count, lot, date code and QR label.

Choose **Receive a package** on Component Parts. Scan the distributor's 2D code or photograph the label, review its part number and count, then receive it and queue its QR label. Digi-Key, Mouser and LCSC labels are decoded locally. Generic ECIA labels require confirmation of the manufacturer part number. Repeating a receipt leaves the count alone; use **Receive another package with this label** for a second physical bag with an identical code.

Set the part's moisture sensitivity level from its manufacturer data. On a package, **Opened** starts its exposure clock and **Back in the dry cabinet** pauses it. An expired package cannot be reserved or consumed until its recorded bake timer is complete. Enter the manufacturer's bake duration, temperature and instruction. The timer records the step and does not control an oven.

Use **Record placements** to consume components including the package's attrition percentage. **I counted it** replaces the estimate with a measured whole count without changing moisture history. See [Electronics assembly](modules/electronics-assembly.md) for receiving, moisture limits, MSL 6 and API actions.
