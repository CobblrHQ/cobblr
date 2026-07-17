---
type: fix
scope: core-scan
date: 2026-07-17
---
**Scanned covers stay local, so they always come through when you file an item.** A book (or any scanned product) fetches a catalog cover into your workspace's own file store when it lands in the scan inbox. A single transient network hiccup during that download used to leave the item pointing at a bare source URL with no local copy, and when you filed the item there was nothing to attach, so it showed up with no picture. The download now retries, and a heal pass pulls any item that is still stuck on a URL into local storage, so a committed record never depends on re-fetching the original source.
