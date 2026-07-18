---
type: fix
scope: web
date: 2026-07-18
---
**Phone layouts can no longer silently grow wider than the screen.** A dashboard view card with a long view name or item title stretched the whole page past the phone viewport (the card is a grid child, whose minimum width defaulted to its content), and in home-screen (standalone) mode the workspace name rendered under the iOS status-bar clock. Both fixed, and a new automated phone-width sweep (e2e/mobile-overflow.mjs) walks the main routes on a seeded busy workspace and fails on any element that widens the page, so the class stays dead.
