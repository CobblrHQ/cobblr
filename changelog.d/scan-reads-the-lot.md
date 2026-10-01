---
type: feature
scope: core-scan
date: 2026-09-27
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: none (the lot fills the existing Dye lot field and the scan card's captured line)
docs_published: 2026-10-01
---
Scanning a barcode now fills the lot printed beside it: Yarn's Dye lot, or any field you mark as a lot or batch. A lot belongs to that one unit and is never shared with the barcode network.

## docs

**The lot printed on a label is filled in.** When you scan a barcode and the
lot (a dye lot, a lot number, a batch) is printed beside it, the scanner reads
it off the photo it took and fills the field that holds the lot: Yarn's
**Dye lot**, or any field you mark as its lot or batch. A lot you typed
yourself always stays. A lot belongs to that one unit, so it is never shared
with Cobblr's barcode network, even if you typed it into the name.
