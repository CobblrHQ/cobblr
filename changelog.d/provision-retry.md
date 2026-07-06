---
type: fix
date: 2026-07-06
---
**New workspaces provision more reliably.** If a momentary database collision hit while your workspace was being created, signup could return a workspace that wasn't actually set up yet (its first page load failed). Provisioning now retries through that brief contention, so the workspace lands ready.
