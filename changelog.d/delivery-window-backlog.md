---
type: fix
scope: platform
date: 2026-08-25
---
**Switching a delivery channel back to immediate no longer strands what was already queued.** If you had a daily digest with items waiting and switched that channel to immediate, those items used to sit forever behind a window that never opened again; they now go out on the next sweep. And a batched notification whose channel has become permanently undeliverable (Discord disconnected, no bot configured) is now aged out of the send queue after a week instead of being retried forever, so the queue cannot grow without bound. The notification itself stays in your history either way.
