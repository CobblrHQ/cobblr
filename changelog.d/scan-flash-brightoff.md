---
type: fix
scope: scan
date: 2026-08-05
---
The auto-flash now turns itself off when the room gets brighter. It compares the scene against how bright the flash itself made things, instead of waiting for a near-blinding level that normal room lighting never reaches, and it learns from mistakes: if turning off proves wrong (a reflective surface, not better lighting), the bar rises so the same surface cannot blink the light again.
