---
type: fix
scope: ai
date: 2026-07-30
---

Ask Cobb stops failing with "edge request timed out" on longer answers. When the
AI runs tools against your workspace a reply can take a few minutes; Cobblr was
giving up after two and discarding an answer the bridge had already finished.
