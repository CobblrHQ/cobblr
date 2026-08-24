---
type: fix
scope: scan
date: 2026-08-24
---
The scan inbox now says which table a committed scan went into, by its name
rather than an internal code, and points out when a better table has appeared
since the scan was routed. A box of tea scanned before you set up a Tea table
used to file into plain Inventory without a word, because the routing was
worked out once and never revisited.
