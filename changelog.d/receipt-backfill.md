---
type: feature
scope: scan
date: 2026-08-23
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Fill provenance fields from receipts you scanned before those fields existed, and Groceries now records the day you bought something rather than the day you scanned it.

## docs

Turning a set of fields on gives your **next** scans somewhere to land. The
things you filed last month already had their receipts read, and everything
those receipts said was kept, so the answers are still there to move across.

Ask Cobb to *"fill in where my things came from"*, or call it directly:

```
POST /api/v1/orgs/<slug>/modules/core-scan/receipts/backfill-fields?dry_run=true
```

The dry run tells you what it would fill without writing anything. It reports
how many items it looked at, how many it filled, how many already had answers,
and how many never came from a receipt.

It only ever fills a field that is **empty**. If you typed "a gift from Mum"
into *Acquired from*, a receipt disagreeing with you does not get to win.

**Groceries** now brings its own *Bought on* date as well, so shelf life counts
from the day you bought something even if you scan the receipt a week later. If
you also switched Provenance on, you get one date field rather than two: they
deliberately share a name.
