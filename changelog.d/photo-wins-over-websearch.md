---
type: feature
date: 2026-06-22
---
When you add a photo to a scan whose barcode came back wrong, the photo now wins. A barcode/web search can return a spurious listing (a debug probe coming back as a "power supply"); if your photo unambiguously shows a different product, the item is now renamed to what the photo shows: the old wrong title is dropped, the photo-derived details become the ones to work from, and the corrected barcode→name is reported back to the shared barcode database so the next scan is right. (Previously this check only ran for direct barcode hits, not web-search results, so a wrong web-search title would stick.)
