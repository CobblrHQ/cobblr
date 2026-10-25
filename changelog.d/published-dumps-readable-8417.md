---
type: fix
scope: platform
date: 2026-10-25
---

Off-box backup copies can read the nightly dump again. Since an earlier fix, each dump was saved readable only by its owner, so a copy run as another user missed it; dumps are readable again, and the ones saved meanwhile are fixed on the next start. If you copy dumps off the box, check that the last few nights arrived.
