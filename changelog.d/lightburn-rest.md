---
type: feature
scope: digifab
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#LightBurn job review
docs_published: 2026-10-08
---
Added LightBurn file upload and live status through its REST API, with cut settings and material library details to review before approving each laser job.

## docs

### LightBurn job review

Upload a prepared LightBurn project and save its material tag in the Library.
Send it to one laser and open that machine's station. Confirm the loaded sheet
there before opening the file and reviewing its layers, speed, power, passes
and loaded material library. LightBurn does not identify which library entry
was used for this project. An owner or admin at the authorized station chooses
Approve and start laser. Stop it in LightBurn or at the machine and keep it
supervised.

Changing the file or project settings requires a fresh review. Automatic pool
sends, bulk sends and retries do not approve laser jobs; use the machine
station. Running, paused and done follow LightBurn's events, with polling when
needed. Progress appears only when the controller reports it.

Pair the bridge once on the LightBurn computer with the pair-lightburn CLI
command. See the edge-bridge setup guide for network access and secure credential
transfer. A rejected token asks for re-pairing and never falls back to UDP.
Older LightBurn versions use the legacy file-drop path and ask you to check the
settings in the desktop before approval.
