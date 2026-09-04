---
type: internal
scope: demos
date: 2026-09-04
---
CI now records a guided product tour every night and fails if it could not be recorded, if a step was silently skipped, or if the picture froze. Three separate breakages had reached the main branch without anything noticing, because recording a video was the only thing that exercised that code and nobody did it until a video was needed.
