---
type: fix
date: 2026-06-22
---
Scanning a big batch no longer drops items to a raw, uncleaned name or a scary "502" note. The AI bridge that names and sorts each scan is a single agent, and a burst of scans used to overwhelm it, so some items kept the messy web-title ("… - Botland - Robotic Shop") instead of the tidy name the AI would have produced. Scans now queue gently to the bridge (a few at a time) and retry a momentary overload, so far more items come back with a clean AI name. Also: junk "inventory checker / price tracker" pages (BrickSeek, camelcamelcamel, bare UPC-lookup results) are no longer mistaken for the product name.
