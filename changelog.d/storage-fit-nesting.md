---
type: fix
scope: scan
date: 2026-08-23
---
Fixed being warned that something was in the wrong place when it was not. Putting a chilled item on a shelf inside the fridge counted as a mismatch, because only the shelf was looked at and not the fridge around it. The whole chain is checked now, and a warning about a particular spot is only given once rather than every time something is picked up and put back.
