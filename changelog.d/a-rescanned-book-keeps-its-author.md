---
type: fix
date: 2026-09-14
---
Scanning a book's ISBN a second time keeps its author and year: the cached answer now carries everything the first lookup learned, so a later scan does not ask the book catalog again and cannot lose the details to a throttled reply. A book found through the Open Library fallback is cached too.
