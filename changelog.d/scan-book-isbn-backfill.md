---
type: improvement
scope: scan
date: 2026-07-05
---
Photographed books now get their **ISBN backfilled from Open Library**. An ISBN is almost never printed where a camera can read it, so when a book's match has no ISBN, Cobblr looks it up by title + author — preferring the edition whose publisher matches the book in hand (e.g. the Scholastic paperback, not a random hardcover). It only fills a blank ISBN (never overrides one the identify already found) and leaves it empty when there's no confident match rather than inventing one.
