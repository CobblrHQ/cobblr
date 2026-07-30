---
type: fix
scope: backup
date: 2026-07-30
---
Google Drive backups no longer pile up forever: retention now applies to Drive (it keeps the newest N and deletes the rest, like the NAS and S3 destinations already did). Redundant backup runs are also suppressed, so a deploy or restart can't fire a burst of near-identical backups, and backup filenames now include seconds so two runs in the same minute stay distinct.
