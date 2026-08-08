---
type: fix
scope: platform
date: 2026-08-08
---
A workspace is no longer offered record types belonging to modules it never turned on. Scanning or searching used to probe every record type the server knows about, including ones your workspace does not have, which produced errors in the log and wasted work on every scan.
