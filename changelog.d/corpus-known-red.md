---
type: internal
scope: ci
date: 2026-09-17
---
**A known defect is held out of the corpus floor by name.** A case that cannot pass until its issue is fixed carries `known_red: "#<issue>"`: asked and recorded, held out of the floor, its passing reported, and a marker that passes three runs in a row is called stale in the bench log and once in the infra channel. The gate no longer needs every known defect cleared before it can be green, and the bar over everything not named stays where it was.
