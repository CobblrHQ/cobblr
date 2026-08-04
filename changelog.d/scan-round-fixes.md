---
type: fix
scope: scan
date: 2026-08-03
---
Four scan fixes from shelf testing. Committing an item with a very long catalog title no longer fails with bad request body; the name is trimmed to fit instead. The scanned-result sheet no longer offers to file the item anywhere, since scans always land in the inbox and routing happens there. The sheet gained a photo strip showing every picture on the item, so a shot added with the plus shutter never vanishes into a different surface, and the drawer thumbnail no longer goes blank after adding one. The scan inbox session header also stops overlapping its End control on phones.
