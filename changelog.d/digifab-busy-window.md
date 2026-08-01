---
type: fix
scope: digifab
date: 2026-08-01
---
A pool no longer sends a second print to a printer that is already spoken for. A printer counted as free while its file was still uploading, while the manager had the job but had not started it, and while a print was paused, so two plates could go to one machine.
