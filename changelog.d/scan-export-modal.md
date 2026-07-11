---
type: improvement
scope: scan
date: 2026-07-11
---
The scan inbox **Export** button is no longer a blunt "dump everything." It opens a chooser: pick exactly which items (checkboxes, pre-ticked from whatever you had selected), and choose how photos travel. **Link** keeps the file small and hands the destination a per-file, expiring link to fetch each photo (you pick the expiry: 1 hour, 24 hours, or 7 days). **Baked in** embeds the images in the export file itself, so it is fully self-contained and works for an offline or LAN-only destination that cannot reach back. **None** exports metadata only. The instance sets the default mode (self-hosters default to Baked in; a hosted instance can set `SCAN_EXPORT_DEFAULT_PHOTO_MODE=link`) and you override it per export. On the security side, a Link export now mints a **per-file** token scoped to only the file it names, instead of one org-wide token, and the default lifetime drops from 14 days to 24 hours. The importer restores baked-in photos with no network and still fetches links when present.
