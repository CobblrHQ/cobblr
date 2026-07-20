---
type: improvement
scope: scan
date: 2026-07-20
---

Scanning a part's own serial number with the camera now opens that part, even when no redirect rule is set up. Cobblr falls back to the fields a module marks as identifiers, so a workspace that lasers its own serials no longer has to configure anything first. If a serial belongs to more than one part, it asks which one rather than guessing.
