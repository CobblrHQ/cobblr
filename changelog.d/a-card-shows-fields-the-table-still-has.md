---
type: fix
scope: scan
date: 2026-09-03
---
A scan waiting in the inbox no longer shows fields its table has since dropped. A match is a snapshot of the table as it was, so an item scanned before a bundle upgrade could show a retired field beside the real one that replaced it, and filing it wrote that value somewhere nothing would ever show it again. The card now reads the table as it is today, and says what it read that no longer fits.
