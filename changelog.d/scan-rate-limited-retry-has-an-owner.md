---
type: fix
scope: scan
date: 2026-08-14
---
A scan whose barcode look-up hit a busy catalog is now retried by the server, so it keeps trying after you close the tab. The item shows which attempt it is on, and once the attempts run out it says so and points you at filling in the name or adding a photo.
