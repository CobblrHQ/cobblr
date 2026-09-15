---
type: feature
scope: scan
date: 2026-09-15
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Typing a model number now looks it up.** Type "PB287Q" into the dashboard's box (or the scanner's) and the inbox row gets the web lookup, the product's name and picture, then the match, the same way a scanned barcode does; a typed product code takes the catalog. The card under "what you've added" opens the row it made and shows its progress while it fills in. Tapping a box on a phone no longer zooms the page.

## docs

**Typed entries take the whole pipeline.** What you type decides what runs: a product code (a UPC, an ISBN, a URL) goes to the catalog like a scanned one; a model, part or serial number ("PB287Q", "WD40EFRX") is looked up on the web, and a name the web agrees on replaces the code, with the product's picture; plain words ("a box of screws") go straight to the matchmaker, which then finds a picture for what it routed. A lookup that finds nothing keeps the words you typed. The card under **What you've added** on the dashboard opens its inbox row (the item screen on a phone) and shows the row's progress while the lookup and the match are still running.
