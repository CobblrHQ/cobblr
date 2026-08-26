---
type: improvement
scope: ai
date: 2026-08-26
---
The bundle builder now checks the AI's proposal against the workspace before showing it: a field the kind already has (a "brand" when it ships "manufacturer") is left out and said so, a request that names nothing to track gets an explanation instead of invented fields, and the modules a bundle needs are worked out from what it references rather than trusted to be listed. Models that can be held to an output shape are, so a garbled reply cannot happen.
