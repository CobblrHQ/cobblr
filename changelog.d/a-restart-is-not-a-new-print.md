---
type: fix
scope: digifab
date: 2026-08-29
---
Restarting the server no longer announces "Print started" for a print that was already running. The printer watcher kept the last state it had seen in memory only, so a fresh process saw every printer as brand new and reported an ongoing print as one that had just begun (and opened a duplicate row for it in print history). It now reads the last state back from the workspace, and a first look at a printer, with nothing to compare against, reports progress rather than inventing a start.
