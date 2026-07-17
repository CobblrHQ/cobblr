---
type: improvement
scope: core-authoring
date: 2026-07-17
---
**AI-authored collections come out lean, not cluttered with a borrowed module's fields.** When you describe a new kind of thing and the builder tracks it on top of an existing module (a Bookshelf built on Assets), that thing used to inherit the module's built-in fields, so an authored book showed State: Working, Warranty until, and Serial number that make no sense for a book. The builder now marks each new collection base or inherit: a catalog you look things up in (books, movies, records, wine) keeps only name, photo, location, and notes plus its own fields and drops the module's built-ins, while a thing you own and maintain (tools, vehicles) keeps them. So an authored Bookshelf arrives clean, with no trip to the Fields editor.
