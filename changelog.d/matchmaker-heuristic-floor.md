---
type: fix
date: 2026-06-22
---
When AI isn't doing the matching, the inbox no longer force-fits an item into the wrong bundle. The keyword matcher used to suggest any table that shared a single word, so a "Pine64 LCD Ribbon Cable" got tagged **Yarn** (because "ribbon" is a yarn word). Now a table is only suggested when the item actually *is* that kind of thing (its noun matches) or a specific attribute matches, otherwise the card just offers the generic "Inventory part." Fewer, better chips (at most two), and no more cables in the yarn bin.
