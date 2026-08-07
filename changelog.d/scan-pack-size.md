---
type: feature
scope: scan
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
Scanning a multipack now records the pack you're actually holding. Household Supplies' "Usual pack" field is now "Pack size": it captures the package you scanned (a single, a 10-pack), read off the box, instead of guessing what you usually buy. Pack size is a platform dimension now (alongside quantity and unit), so any tracker can carry it and the scan fills it the same way.

## docs

**Pack size on a scan.** When you scan a multipack (a 10-pack of switches, a box of 100 screws), the scan reads the pack count off the package and fills the table's **Pack size** field with it. Pack size is the count in the package in front of you (a single, a 10-pack). It is separate from **Quantity** (how many you have) and the **unit** (each, L, kg). It's filled from what's printed on the box, not a guess about what you usually buy, so re-scanning the same item lands the same pack every time.

A table opts into pack size by giving a field the `pack` role. Household Supplies' "Pack size" field is the built-in example. If you build your own tracker and label a field around "pack", the platform expects that role (so the scan can fill it) and won't let the field be framed as a buying habit.
