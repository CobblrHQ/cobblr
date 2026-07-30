---
type: fix
scope: scan
date: 2026-07-30
---
Fixed the colour disappearing from an item's title at the end of an AI run. The colour is now composed into the title when the item is read, instead of being written into the stored name where any of the nine passes that rewrite a name could drop it. Replaying an item shows it too.
