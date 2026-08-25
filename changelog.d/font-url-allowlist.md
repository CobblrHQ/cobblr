---
type: improvement
scope: platform
date: 2026-08-25
---
A workspace custom font now has to come from a safe source: an uploaded font, a same-origin file, or a well-known font host. This stops a theme from quietly pulling a font off an arbitrary outside server on every page load.
