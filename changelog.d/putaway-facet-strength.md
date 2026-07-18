---
type: fix
scope: scan
date: 2026-07-18
---
**Live Sort routes to the bin that actually holds the family.** The category facet used to send an item to the first bin containing ANY of its category, which favored big mixed bins holding one stray over a bin devoted to the category, and the "N similar items already here" line always said 1. It now counts how many of the category live in each bin and picks the strongest home, and receipt line items got a database index so confirming a long receipt stops rescanning the whole inbox per line.
