---
type: fix
date: 2026-08-18
---

Your AI bridge no longer drops out when Cobblr updates itself. The connection
between Cobblr and a bridge running on your own machine was held in the memory
of whichever server process the bridge happened to reach, so a restart or a
routine update could leave Cobblr reporting no bridge connected while it was
running perfectly well, and requests would fail in a pattern where one worked
and the next did not. That connection is now shared, so any part of Cobblr can
reach your bridge.
