---
type: feature
date: 2026-06-21
---
When you scan a barcode **with the camera**, Cobblr now double-checks the result against your photo. After the barcode resolves to a product name, a vision model glances at the picture you captured and asks "does this actually look like that?" — and if it clearly doesn't (a store-local or reused barcode resolving to an unrelated product), the item is flagged "⚠ this photo doesn't look like *X* — the barcode may be wrong" with its confidence dropped, so you catch the mismatch instead of filing the wrong thing. Runs in the background (your named item appears instantly) and only fires when there's a photo to compare. A fix you make then flows to the shared Barcode Intelligence DB so the next scan of that code is right.
