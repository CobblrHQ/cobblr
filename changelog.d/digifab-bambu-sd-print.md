---
type: improvement
scope: digifab
date: 2026-07-02
---
Bambu printers on LAN now list the files already on their SD card in the cockpit's "Files" panel, so you can start (or re-run) any of them with one click — no re-upload. Previously the panel was always empty for Bambu because file operations went through the cloud driver, which can't touch the SD card; they now route over your LAN bridge like the camera and controls do.
