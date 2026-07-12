---
type: improvement
scope: core-scan
date: 2026-07-12
---
Photo scans now read a serial number or service tag off an item's label and file it into a real **Serial number** field on the item, not just the scan notes. It is read verbatim (never guessed or completed from a partly-hidden label), and Machines gained a native serial number field to receive it (Assets and Inventory already had one). Relabel it per table if you like, "Service tag", "VIN", and so on.
