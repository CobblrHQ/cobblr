---
type: fix
---
**Fixed a printer modal flicker.** A printer photo set via the web-image search could make the detail modal flash, from a doubled image URL (404 → retry). The file-URL helper is now idempotent so an already-resolved image path is never wrapped twice.
