---
type: feature
scope: digifab
date: 2026-07-03
---
AI failure detection (the spaghetti watch): turn it on in Setup and Cobblr watches each printing machine's camera, builds a rolling failure score, and auto-pauses + alerts you when a print is clearly failing. It uses a local model on your bridge when available — the frame never leaves your network and costs no AI tokens — and falls back to your workspace's vision AI. Tune the sensitivity, the detector, and whether it auto-pauses or just alerts.
