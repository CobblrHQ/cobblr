---
type: fix
scope: ai
date: 2026-08-26
---
The builder no longer lists a made-up module when a bundle keys fields to one of your own lists (a "Medications" list is not a module), and it now counts the modules a bundle's automations touch, so a bundle that wires up a label print requires Labels. The operator's authoring eval also retries once when a model answers in prose, the same as the builder does.
