---
type: improvement
scope: core-scan
date: 2026-07-14
---
**A barcode scan with a photo now reads that photo once, not twice.** When a scanned barcode resolves to a name, Cobblr sanity-checks it against your photo: "does the picture actually show this product?" That check was a separate look at the image by the vision model, even though another step had usually already looked at the same photo and written down what it saw. When that description already exists, the sanity-check now just compares the resolved name against the description in text, which is cheaper, faster, and spends no vision budget. If nothing has described the photo yet, it falls back to looking at the image as before. No change to what you see; it just stops paying to read the same photo a second time.
