---
type: fix
date: 2026-08-10
scope: views
---

The What's on hand view never showed anything about expiry. Items going off tomorrow looked the same as items with months left, because the view read only the built-in fields and expiry is one a bundle adds. It now reads both, so the status dot means what it says.
