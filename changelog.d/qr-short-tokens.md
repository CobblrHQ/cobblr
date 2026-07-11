---
type: improvement
scope: labels
date: 2026-07-11
---
QR label URLs are much shorter. A descriptive token is now a short kind code plus a 12-char slug (e.g. /qr/loc/Xk7d2mNq9pLc) instead of the entity's full UUID, so the QR is less dense and scans more reliably on small labels. Already-printed labels keep resolving. Public labels stay opaque and unguessable (a longer slug, no readable prefix).
