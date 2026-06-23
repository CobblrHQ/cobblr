---
type: fix
---
Scan catalog images are far more accurate for store/own-brand products. The image search now includes the brand in the query (not just the ranking), so a generic name like "Blended Scotch Whiskey" + brand "Kirkland Signature" no longer comes back as a random Johnnie Walker bottle. The brand is skipped when the title already contains it, so the query is never duplicated.
