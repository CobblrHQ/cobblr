---
type: improvement
scope: platform
date: 2026-07-02
---
A disaster-path restore that doesn't need Cobblr running. If the api won't boot, `api/scripts/restore-backup-offline.ts` loads a backup's data straight into the tenant database with plain Postgres access: dry-run preflight, ids preserved, type-aware, all-or-nothing. The in-app restore remains the full-fidelity path; this is for the day that path isn't available.
