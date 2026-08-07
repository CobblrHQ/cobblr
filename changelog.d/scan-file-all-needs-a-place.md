---
type: feature
scope: scan
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
Filing a whole scan session now asks where the things go instead of quietly saving them with no location. If every item already has a spot, or you have an active bin set, it files straight away as before. Otherwise it shows the rooms and bins, and filing without a location is still one tap if that is what you want.

## docs

Filing needs two things: a category, and somewhere to put the thing. **File all** now checks both.

- If every item already has a location, or you have an active filing bin set, it files immediately.
- If some items have nowhere to go, it asks first: tap a room or bin and the whole session is filed there. Items that already have their own location keep it.
- **File without a location** is right there if you would rather place things later.

Items filed with no location still exist in their table, but you can only find them by searching, which is why Cobblr now asks rather than assuming.
