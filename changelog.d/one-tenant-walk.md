---
type: fix
scope: platform
date: 2026-09-15
---
**Background housekeeping no longer crowds out the database at startup.** Every periodic pass that visits each workspace (expiry checks, arrival reminders, picture and routing heals, the printer pump's discovery) now runs on one shared walk with one connection budget, its first round spread over its cadence instead of everything firing minutes after boot. On an instance with hundreds of workspaces this is the difference between hundreds of refused connections an hour and none, and the printer pump no longer opens every workspace's database every fifteen seconds to find no printer.
