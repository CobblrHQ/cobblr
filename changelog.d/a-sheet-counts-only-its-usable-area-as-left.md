---
type: fix
scope: inventory
date: 2026-10-08
---
A sheet's "percent left" now counts only material you can still cut a part from. A sheet nested with outlines, such as a sheet of stars, used to count the slivers between the parts as left; it now reads the free rectangles at least the minimum usable size, the same area that decides whether a part fits.
