---
type: fix
date: 2026-06-22
---
Three inbox fixes. **Undo on remove:** removing a scan (one or a whole selection) now shows an "Undo" button right on the toast, so a mis-tap is one click to put back instead of a trip to Recently deleted. **Right words for a barcode:** an item that's just a barcode (no photo) no longer says "Couldn't identify this photo". It says "barcode". **No more stuck "Awaiting lookup":** when a barcode lookup is rate-limited and the automatic retries are used up (e.g. the daily lookup quota is spent), the item now settles into a clear "couldn't identify, name it" with the name box ready, instead of spinning "retrying…" forever or sitting on a misleading "Awaiting lookup…".
