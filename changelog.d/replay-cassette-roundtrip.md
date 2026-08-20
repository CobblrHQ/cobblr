---
type: internal
scope: ai
date: 2026-08-19
---
The replay AI provider reads its cassette directory on every call instead of once at boot, so a scenario recorded against a real model replays immediately without restarting the API. Its "no cassette matches" error now also lists what the directory actually holds.
