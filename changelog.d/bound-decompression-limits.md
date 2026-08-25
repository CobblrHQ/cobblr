---
type: fix
scope: platform
date: 2026-08-25
---
Catalog pulls and backup restores now stop reading once a compressed source would inflate past a safe size, so a maliciously tiny but highly compressed file can no longer exhaust server memory.
