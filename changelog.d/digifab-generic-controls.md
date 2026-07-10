---
type: improvement
date: 2026-06-21
---
**Generic printer controls.** Every printer's fleet card now has a **Controls** panel that shows exactly what *that* printer can do: declared by its driver. Bambu (cloud) gets pause/resume/stop, jog (X/Y/Z), chamber light, and nozzle/bed temperature; the declarative managers (OctoPrint/Klipper/Duet) get whatever their manifest declares, including custom commands. Only supported controls appear.
