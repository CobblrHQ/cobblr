---
type: improvement
scope: scan
date: 2026-07-05
---
Self-hosters can now control exactly which third-party product catalogs barcode scanning contacts — a master switch (`COBBLR_SCAN_EXTERNAL_LOOKUPS`), independent per-provider toggles (upcitemdb, Open Facts, DuckDuckGo, go-upc), and API-key fields where a provider offers one. go-upc uses its official API when you supply a key; its web scraper is now off by default.
