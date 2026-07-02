---
type: fix
date: 2026-06-24
---
A research-hint correction on a barcode item now actually re-identifies it. Before, a hint like "it's 1 unit, not 96 packs" was stored but never re-ran the lookup when the provider already had a (wrong) name, so nothing changed. Now a hint re-derives the name via the web identify and accepts the corrected result even when it's shorter than the wrong one.
