---
type: improvement
scope: platform
date: 2026-09-22
---
**The desktop auto-update feed now serves multiple apps at once.** Releases are namespaced by product, so the Edge Helper and the new Studio cockpit each get their own update stream from one instance. A release for one is never offered to the other. Backward compatible: the existing unprefixed feed keeps working unchanged. This also fixes Studio's updater, which shipped pointing at its own feed before that feed existed and had been answered with a 404 ever since.
