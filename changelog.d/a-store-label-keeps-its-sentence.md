---
type: fix
scope: scan
date: 2026-09-13
---
**A scan's note names the step that actually decided.** A store's own label (a deli, produce or in-store code that is never looked up) scanned in a workspace whose AI was erroring showed "The AI errored on this one, so it was matched by keywords" instead of saying it is a store's own label. The card now leads with what the lookup found and adds the routing's sentence after it, as its own, when there is one.
