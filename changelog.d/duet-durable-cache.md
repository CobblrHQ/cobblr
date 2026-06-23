---
type: improvement
---
**Printer file lists & previews are now served from a durable backend cache.** A background warmer keeps each printer's file list and gcode thumbnails fresh in the database, so opening a printer is instant and never pulls from the machine itself — the printer is touched only on the backend's schedule, and each thumbnail is fetched exactly once.
