---
type: fix
scope: platform
date: 2026-07-14
---
Fixed: **Add field** was dead when you scoped a field to a class of things. A field aimed at a class has no single entity kind by design (the system works it out from the traits you tick), but the button was still waiting for one, so it stayed greyed out no matter what you filled in, and it never said why. The button now reads the same readiness rule the form itself uses, so the two cannot disagree, and when it is greyed out it tells you what it is waiting for. Choices and Renderer now also share a row rather than stacking as two full-width bands.
