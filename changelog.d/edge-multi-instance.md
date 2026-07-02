---
type: improvement
date: 2026-06-20
---
One edge bridge can now front **all the machines on your site** over the tunnel. The cloud routes each call to the right machine by its instance id (`/voron/devices`, `/mk4/status/…`), so a single bridge with several configured machines — Klipper here, a Prusa there, a Duet too — all reach a hosted Cobblr through one dial-out connection. Add a machine = add an instance to the bridge config + a connection in Cobblr.
