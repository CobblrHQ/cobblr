---
type: fix
date: 2026-06-23
---
Thin-hit enrichment now captures the spec, not fluff: when a barcode resolves to a bare name and we enrich from the web, the result keeps the package size / quantity (1.75 L, 750 mL, 12 ct, proof) that identifies the SKU, and only replaces the thin name when it actually adds the size or the brand — never just longer marketing wording.
