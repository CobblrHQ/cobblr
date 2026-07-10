---
type: improvement
scope: locations
date: 2026-07-10
---
The floor plan's entity occupants now derive placeable kinds from the entity-kind registry (declared list + update endpoints, physical trait) instead of a baselined hardcoded module list. Any future module's items become placeable with one manifest line; the lint baseline is empty again.
