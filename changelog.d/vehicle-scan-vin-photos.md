---
type: fix
scope: platform
date: 2026-07-24
---
**A scanned identifier and every photo you captured now survive the commit.** When you scan an item whose barcode decodes to an identifier (a VIN off a vehicle, a serial off a nameplate), that value now lands in the item's real serial-number field instead of getting stranded in hidden metadata where the field could not see it. And when you merge several shots into one item (the barcode plus the plate, say), all of them attach as gallery photos, not just the catalog stock image. Both were silent data loss on confirm.
