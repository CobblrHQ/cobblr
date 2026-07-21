---
type: feature
scope: printing
date: 2026-07-21
docs_target: none (USER_GUIDE section 3.2 Labels updated inline in this PR)
---
Auto-print labels as they are added: turn on Auto-print on the Labels page, pick a network printer and a size, and choose to print when a sheet fills up, every N labels, or each one immediately. Cobblr renders and sends the job in the background, records a re-printable batch, and a short cooldown stops a burst of scans from firing a print per scan. Off by default.
