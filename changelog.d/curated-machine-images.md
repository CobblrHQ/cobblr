---
type: improvement
date: 2026-06-20
---
Known machines now get the **right** product photo. Cobblr checks a curated image catalog (the `CobblrHQ/printer-images` manifest) before its live web-image search, so a Prusa Mini stops showing up as an MK4. Fix or add a model's photo in that repo and it updates within minutes: no Cobblr redeploy.
