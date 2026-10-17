---
type: fix
scope: kernel
date: 2026-10-17
---

A module part that is turned off now refuses its routes whatever capitals they are written with. Before, `/ARMS/1` still answered after Robot arms was off, because the gate matched the exact text while the router did not.
