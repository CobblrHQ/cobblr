---
type: feature
scope: digifab
date: 2026-10-04
docs_target: docs/operations/edge-bridge-setup.md#macOS
---
Added a native Mac bridge installer with automatic updates, LightBurn pairing, and checks that explain what the laser needs before a job.

## docs

### macOS

Choose macOS in the edge connector setup and paste its one-line install into
Terminal on the Mac running LightBurn. It installs a native user service with
no Docker, Xcode or administrator password. Enable LightBurn's API under
Settings > Extensions and its UDP automation listener, then run the pairing
command shown in setup and approve LightBurn's dialog. The bridge picks up
pairing automatically. Add a LightBurn laser with host 127.0.0.1 and open its
controls to check API access, pairing and UDP readiness.

Send an individual SVG, DXF or LightBurn project job, review its layers and cut
settings, and approve Start while supervising the laser. The same setup includes
an uninstall command. Use LightBurn or the physical stop control to stop the laser.
