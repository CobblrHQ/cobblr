---
type: fix
date: 2026-08-24
---

Parcel tracking now tells the tracking service which carrier a number belongs to. Without it the service had to guess, and for a plain 12-digit number it often could not, so the parcel sat unresolved and never updated even though the number was perfectly valid. Numbers already added that got stuck this way are repaired automatically on the next check.
