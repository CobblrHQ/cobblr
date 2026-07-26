---
type: fix
scope: labels
date: 2026-07-26
---
Fixed a serial-connected label printer being treated as a sheet printer, so it defaulted to US Letter with 20 labels per page instead of its own roll, was skipped by auto-print, and was ignored when a module asked to print something.
