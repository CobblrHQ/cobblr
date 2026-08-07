---
type: fix
scope: platform
date: 2026-08-07
---
The automatic database upgrade now works on real installations. Testing it against a copy of a live 251-workspace database found six separate faults, including one that would have stopped every existing installation: PostgreSQL 18 turns on data checksums by default and refuses to upgrade a database created without them. Each failure stopped safely with the original database untouched, which is the designed behaviour, but none of them would have been caught by reading the code. The upgrade is now exercised in CI against a real previous-version database on every build.
