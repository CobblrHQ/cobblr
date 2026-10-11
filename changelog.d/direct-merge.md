---
type: internal
date: 2026-10-11
---

Pull requests merge directly: a green one lands at once unless main changed its files since its run, in which case it is re-run once against current main first, and only the newest main commit gets an image.
