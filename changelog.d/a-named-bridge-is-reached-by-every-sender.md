---
type: fix
date: 2026-09-23
---
A named edge bridge is now reached by everything that sends to it. A bridge name longer than 60 characters, or one with a space at either end, could register under one address while print jobs, sync sources, AI providers or parcel tracking sent to another, so the bridge looked offline while it was polling.
