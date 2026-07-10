---
type: feature
date: 2026-06-22
---
Book and music scans now resolve from the local mirrors. A scanned book's ISBN-13 is an EAN barcode, so it's now looked up through the shared barcode database (which now holds the Open Library catalog): instant, offline, no per-scan call to Open Library's API; a brand-new book not yet mirrored still falls back to the live API. CDs/vinyl already went through that path, so they pick up the new MusicBrainz music data automatically. Provenance reads "Open Library" / "MusicBrainz".
