---
type: improvement
scope: core-integrations
date: 2026-08-27
---
A live sync source can now turn the tags on a mirrored record into Cobblr tags. Homebox labels and Part-DB tags become real tags on the imported part (attached by name, created if missing, never removed), instead of riding along unseen in the item's details. If a tag cannot be attached the import result counts it rather than dropping it quietly.
