---
type: fix
scope: labels
date: 2026-07-11
---
Opening Labels no longer crashes with a "Something broke on this page" error while the list of labelable items is still loading. A hook in the browse panel ran only on some renders; it now runs on every render.
