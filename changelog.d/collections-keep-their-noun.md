---
type: fix
scope: platform
date: 2026-09-03
---
Renaming a collection, changing its icon or moving it in the nav no longer forgets what the things inside it are called. Those settings were saved as one blob, and the form rebuilt the blob from the handful of fields it knew about, so a Bookshelf that called its items books quietly went back to the generic word and its New button read "New record". Saving now only changes the settings you actually edited. You can also set the word yourself: instance settings has a "One of them is called" field, so a Bookshelf holds books and a Fleet holds vehicles. And every place that counts your things now uses the workspace's own word properly, so no more "18 inventorys". A collection that has never been given a word no longer borrows one from the plumbing either: it says "item" until you set the real one, because a Bookshelf holds books and calling them records was never right. The same fallback is gone from asset and machine collections too, and creating a collection that already had an icon or a nav position set now still gets its word instead of silently going without one.
