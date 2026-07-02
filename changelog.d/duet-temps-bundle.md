---
type: fix
date: 2026-06-23
---
**Duet printers report live temps.** The edge-bridge Duet driver now reads bed/chamber/nozzle temperatures (from `rr_status?type=2`), so a Duet on the local bridge shows live telemetry like the others. Ships via the embedded bridge bundle — bridges self-update automatically.
