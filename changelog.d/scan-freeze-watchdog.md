---
type: fix
scope: scan
date: 2026-08-05
---
The camera scanner no longer comes back frozen after minimizing the app or switching away. A watchdog now watches for frames actually arriving (instead of trusting what the camera claims) and restarts the stream within a few seconds whenever the picture stalls.
