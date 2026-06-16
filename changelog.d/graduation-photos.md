---
type: feature
scope: platform
---
**Graduation copies your photos too**: when you start a full workspace from a managed app and "bring my data over", each item's photo now comes along — duplicated byte-for-byte into the new workspace's own file store (its own file id, a fresh workspace-scoped URL), so it survives even if the original app is later deleted. External catalog images (a barcode lookup's photo) are portable, so they pass straight through. Built on a new `platform().files.write` seam (core-files registers it), the symmetric partner to `files.read`.
