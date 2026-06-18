---
type: feature
scope: digifab
date: 2026-06-18
---
**Building a print farm from scratch?** Digital Fabrication's new **Add several** button stands up a whole fleet at once: paste a list of printer URLs (one per line — `url`, or `name, url`, or `name, url, apikey`), pick a default firmware, and Cobblr makes one direct connection per printer, installs the drivers it needs, and (optionally) groups them all into a pool. Hit **Detect firmware** and it probes each URL to guess OctoPrint vs Klipper/Moonraker vs PrusaLink vs Duet for you. Tick **test each** to see which came up reachable. (Migrating an *existing* FDM Monster farm? Use **Import farm** instead.)
