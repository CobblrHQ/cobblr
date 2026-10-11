---
type: fix
scope: notifications
date: 2026-10-11
---

**Turning on notifications says what went wrong when it does not finish.** When the browser allowed notifications but would not sign the device up, pressing **Turn on** used to bring the same button back with nothing said. The notifications row and the settings card now say what failed, in the browser's own words where it gave some, and what to do next, with **Try again**. A page whose background worker never started now says so after a few seconds instead of showing "Turning on…" forever.
