---
type: improvement
scope: platform
date: 2026-09-03
---
A field can now say that it means where a thing is kept, and the platform answers that it already knows: Locations owns that question, so such a field is refused when it is created rather than discovered later. The refusal says what to do instead, and points at the migration that retires a place field you already have. This is why bundles kept inventing a Room field; there was no way to say what it meant, so nothing could turn it down.
