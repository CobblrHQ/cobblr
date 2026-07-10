---
type: improvement
date: 2026-06-25
---

- Sync manifests can declare cross-section references: a field (e.g. a printer location_id) that points at another section by external id, resolved through that section id-map to the mirrored Cobblr entity. So importing 3D printers links each to the location you already imported. Shown resolved in the preview.
