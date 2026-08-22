---
type: fix
scope: locations
date: 2026-08-22
---
A location's own page behaves. Opening a room that happened to hold exactly one thing put that thing's count-adjust pad above the room's own name, as though you had scanned a bin; that pad is for bins and now only appears on one. **What's here** was reporting zero for locations that had things in them, because it asked three named modules with a page size their endpoints reject, and swallowed the rejection: it now asks every kind that can carry a location, takes each endpoint's own page size, and says so when a kind could not be read rather than counting it as nothing. And you can add a location inside the one you are looking at, from its own page, whether or not it already has something in it.
