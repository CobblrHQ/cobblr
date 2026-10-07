---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-08
---
Added Snapmaker U1 and legacy HTTP printer setup with touchscreen pairing, four-tool readings and reviewed Start at the machine station.

## docs

In Digital Fabrication, add a LAN bridge and choose Snapmaker U1 or Snapmaker 2.0 (HTTP). For U1, enter the printer's address with Moonraker local access enabled. The fleet and station show all reported tool temperatures and available filament details. The camera appears when snapshots are enabled on the printer.

For an HTTP-capable Snapmaker 2.0, use Find Snapmakers or enter its address. Press Pair Snapmaker and approve the connection on the printer's touchscreen. Cobblr saves the approved token privately. Firmware that advertises SACP, including J1 and Artisan configurations, requires the separate SACP transport.

Queue a sliced G-code file for the printer, then open its Machine station link on a screen beside it. An owner or admin authorizes that screen. Check the bed, filament and installed printing head, choose Review print, then Start print. Changing the file, machine, reported spools or head requires a new review. Laser and CNC heads and files are refused. Pause, resume and Stop stay available without screen authorization. After a print finishes, remove it and record how it came out before starting another.
