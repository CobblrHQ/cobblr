---
type: fix
scope: core-scan
date: 2026-07-14
---
**A scan no longer loses what you told it.** The scan pipeline writes to one shared bag of data on each item, and several passes write to it at different times, some of them minutes apart. A few of those passes were replacing the whole bag instead of adding to it, which quietly deleted whatever anyone else had put there. In practice: a re-run threw away your answer to "keep these together, or split them?" and asked again; a re-run erased the "2 different items" offer and then paid for a second AI call to rediscover it; and when a barcode provider was briefly rate-limited, the retry marker replaced the entire bag, so a receipt line silently fell out of its receipt and an imported row lost the key that stops it importing twice. Every one of those writes is now a merge, so a pass can only touch the keys it actually owns. A new build check (`lint:jsonb-merge`) fails any future write that replaces one of these shared bags, so this class of bug cannot come back.
