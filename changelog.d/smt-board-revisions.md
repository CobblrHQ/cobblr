---
type: feature
scope: builds
date: 2026-10-06
docs_target: docs/modules/electronics-assembly.md#Board projects and revisions
docs_published: 2026-10-08
---
Added board revision imports, component stock checks with attrition and moisture warnings, shortage carts and tracked fabrication purchases.

## docs

Install Electronics assembly and open **Board Projects**. Create a project, then **Import board revision** with a BOM CSV and its centroid file. Confirm the export's coordinate units and bottom X mirroring. KiCad files import directly; Altium and Eagle CSVs use confirmed column headings. Every populated reference needs exactly one placement. Changed files need a new revision name.

On a revision, enter **Boards to make** and **Check BOM stock**. Reserved and moisture-blocked packages cannot fill the requirement, and attrition is included. Download a shortage cart for Digi-Key, Mouser or LCSC, upload it to the distributor, and confirm the column mapping. **Track component purchase** records its planned order. Receive each component package by scanning its distributor label.

Under **Blank boards and fabrication**, upload the fab zip, choose JLCPCB, PCBWay or OSH Park, and enter expected arrival and tracking. **Track fab order** keeps the purchase and zip together. Place the order on the fab's site, then mark its purchase arrived to count the blank boards once. Record a framed or frameless stencil for the revision and keep its received count on the stock page. See [Electronics assembly](modules/electronics-assembly.md) for details.
