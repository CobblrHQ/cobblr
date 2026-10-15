---
type: feature
scope: digifab
date: 2026-10-15
docs_target: none (documented directly in docs/operations/edge-bridge-setup.md, Finding 3D printers)
---

Find Klipper, OctoPrint, PrusaLink, Duet and Bambu printers on your network and add them with their address and connection type already filled in.

## docs

### Finding 3D printers

In Configuration → Devices, choose a connected bridge and scan for machines.
The scan finds advertised Klipper/Moonraker, OctoPrint, PrusaLink and Duet
services, plus Bambu LAN broadcasts. Each result shows its connection type,
address, and model and serial when available. Choose **Name and add** to keep
the detected driver and port. Supply the printer's API key or Bambu LAN access
code when setup asks for it.

Scanning only reads discovery and status information. It does not start a job
or change printer settings. Printers that do not advertise, require credentials
before answering discovery probes, or sit behind multicast filtering may need
their address entered manually.
