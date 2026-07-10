---
type: improvement
scope: digifab
date: 2026-07-03
---
**"Camera unreachable" now tells you *why*.** When a camera tile can't get a frame, Cobblr cross-checks the live bridge status and the printer's own reported state before pointing a finger: **bridge offline** ("nothing on-site can be reached"), **printer unreachable** ("the bridge is connected, so it's probably the printer: powered off, maybe on purpose, or unplugged"), or **camera unreachable** ("the printer is responding and the bridge is fine, check its camera / LAN-access settings"). No more blanket "(bridge?)" when the bridge is provably fine.
