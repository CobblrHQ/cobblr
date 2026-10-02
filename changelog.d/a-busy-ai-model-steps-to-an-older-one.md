---
type: improvement
scope: ai
date: 2026-10-02
---
**When Google's newest Flash is overloaded, Cobblr asks an older Flash.** Google's free tier sometimes turns away every version of its newest Flash model for twenty minutes or more while an older version answers fine. Cobblr now steps down to the older versions Google still serves (found from Google's own list, so nothing breaks when a version is retired), remembers which models were busy for a few minutes so the next request does not wait on them again, and never reads a document with the lighter Lite model.
