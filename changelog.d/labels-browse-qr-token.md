---
type: fix
scope: labels
date: 2026-07-11
---
Labels added from the Labels page's browse panel now encode a scannable QR URL (your label base URL plus a QR token) instead of a bare internal path, so a phone camera opens the record. Previously only the per-item "QR" button did this, and browse-printed labels ignored the custom label base URL.
