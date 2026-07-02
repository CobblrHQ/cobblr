---
type: fix
date: 2026-06-23
---
**Live temps in the printer modal for edge-bridge machines.** The device-detail telemetry was Bambu-cloud only, so a Duet / PrusaLink / Moonraker printer connected through the local edge bridge showed no live telemetry in its modal. It now pulls live temps + state from the bridge's device list when there's no Bambu cloud report.
