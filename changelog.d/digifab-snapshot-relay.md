---
type: feature
scope: digifab
date: 2026-06-18
---
**See your printer's webcam from anywhere — opt-in snapshot relay (off by default).** A printer's camera is usually a LAN-only address, so it only shows in the Fleet when you're on the same network. Turn on **Relay snapshots to cloud** (the camera control on a Fleet card) and the edge agent pushes a frame every few seconds up to Cobblr, which serves the latest back — so you get a **near-live thumbnail of the printer from your phone**, anywhere, without exposing your camera or streaming full video. It's **off until you switch it on** (it uses upload bandwidth), and the tunnel itself still carries only stats, not video — this is the deliberate, cheap middle ground for remote viewing. Paired with the OctoPrint plugin's matching "relay snapshots" toggle.
