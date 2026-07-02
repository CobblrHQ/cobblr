---
type: fix
date: 2026-06-22
---
Scan catalog pictures are more reliable: the image search now retries when DuckDuckGo's image endpoint returns empty (it's flaky from a server IP even when the web search has results), and re-running AI on an item now re-fetches its picture by name — so a barcode whose title was corrected upstream but whose image stayed wrong (e.g. a "Pinecil" showing a ribbon cable) fixes itself on re-run.
