---
type: feature
scope: digifab
date: 2026-07-07
---
Adding a printer to a detection service (like PrintGuard) from Cobblr now works for **any** connection type the detector supports: **including Bambu**: driven by a small manifest mapping rather than hardcoded per type. Mirror an existing Cobblr machine and it reuses the credentials Cobblr already holds (they stay server-side, never sent to your browser); for a Bambu you pick which printer (serial). For a single-printer connection you can tick "stop polling it in Cobblr" so only the detector talks to that printer, no double-load.
