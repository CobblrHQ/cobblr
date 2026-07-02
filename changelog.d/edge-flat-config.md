---
type: fix
date: 2026-06-20
---
Fixed an edge-bridge printer getting stuck on "loading…" with a dead Link button. The machine's host/key wasn't reaching the bridge (a config-shape bug), so a PrusaLink/Duet printer never appeared. Also: a direct driver (PrusaLink, Duet, LAN Bambu) IS the one printer, so its detail no longer shows a pointless "which printer" dropdown — it links directly. The dropdown now only appears for a true multi-printer farm manager (FDM Monster / OctoPrint).
