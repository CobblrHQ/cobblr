---
type: fix
scope: labels
date: 2026-07-24
---
**Label queue rows show the instance name, not the raw kind.** A 3D printer added to the label queue now reads as "3D Printers" (its instance), the way you see it everywhere else, instead of the internal "machines/machine". The row prefix is resolved the same instance-aware way the caption already was, so anything filed under a named instance (vehicles, laser cutters, a custom parts bin) labels with the name you gave it.
