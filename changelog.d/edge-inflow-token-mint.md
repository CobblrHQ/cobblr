---
type: improvement
date: 2026-06-20
---
Installing the edge connector is a smooth in-flow step now — no trip to another page. Add a printer that's on your network from a hosted Cobblr, pick **"Via an edge bridge"**, and the dialog: asks **what it's bridging** (Klipper / Prusa / Duet / Bambu-LAN / LightBurn, pre-selected from the printer kind, with the right fields), **generates a least-privilege token for you** (new `devices:edge` scope — it can *only* run the bridge), and bakes both into a ready-to-run command. It then watches for the bridge to dial in and lets you pick the machine.
