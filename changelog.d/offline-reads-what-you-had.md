---
type: feature
scope: web
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#On a phone
---
**Cobblr opens without a signal.** Installed or in the browser, a page you have opened before now opens offline, showing what you had with a bar that says how old it is ("You're offline. Showing what you had as of 14:02."). Changes wait until you are back, and the page refreshes by itself when the connection returns. Opened offline before anything was kept, it shows its own offline screen with Retry instead of the browser's error.

## docs

**Offline.** Cobblr keeps the pages you open on your device, so the next time you open one without a signal (a basement, a garage, a train) it still opens:

- The bar at the top says **You're offline** and how old what you are looking at is: *Showing what you had as of 14:02*. Nothing kept is ever shown as if it were live.
- Changes wait until you are back: saving, scanning and moving things need the connection, and say so if you try.
- When the connection returns the bar goes away by itself and everything on screen is fetched fresh. **Retry** checks straight away.
- A page you have never opened on this device cannot open offline; Cobblr says so on its own screen rather than the browser's error, and opens it by itself once you are back online.
- Signing out forgets everything kept on the device.
