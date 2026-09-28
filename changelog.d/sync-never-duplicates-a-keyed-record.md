---
type: fix
scope: integrations
date: 2026-09-28
---
A sync no longer makes a second copy of something you already have. A machine, part, asset or location you made by hand (or with an assistant) and tagged with the source's id is now updated in place by the next sync, and the import preview shows it as a match instead of a new record. Two syncs writing the same new record at once leave one copy, not two. Every record a sync creates or updates now says so in its history, named after the connection it came from.
