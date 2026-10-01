---
type: fix
scope: search
date: 2026-09-30
---
Search finds what you typed. A `%` or `_` in a search used to act as a wildcard, so "50%" found everything with "50" in it; both are now plain characters everywhere you can search. A record in a collection like a Bookshelf is found by the fields the collection added, such as a book's author, not only by its name. And a search with a bad setting names the setting instead of saying a search word is missing.
