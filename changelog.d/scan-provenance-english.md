---
type: feature
date: 2026-06-22
---
Two scan clean-ups. **Clearer provenance:** when a barcode resolves instantly from the shared Barcode Intelligence DB (its cache or the grocery mirror) the note now reads **"BIdb / go-upc"** instead of a bare "go-upc", so an instant hit no longer looks like a live lookup it couldn't have been. **Better English names from web search:** the fallback that names an item from web results now prefers English titles over foreign-market listings (it was only filtering non-Latin scripts, so French/Spanish names slipped through), fewer "pâte à tartiner" names when an English one is available.
