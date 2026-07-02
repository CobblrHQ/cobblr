---
type: improvement
scope: platform
date: 2026-07-02
---
The tenant-credentials encryption key can be **rotated** now. `api/scripts/rotate-tenant-creds-key.ts` re-encrypts every workspace's stored DB credentials to a new key — dry-run first, every row verified before anything is written, all-or-nothing, safe to re-run. "Never lose the key" is still good advice, but it's no longer the entire disaster plan.
