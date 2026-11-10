---
type: feature
scope: digifab
date: 2026-11-10
docs_target: none (documented directly in docs/design-decisions/an-undo-is-exact-or-it-says-no.md, The judge only sees what a step names)
---

Undoing a new printer pool no longer removes it once a teammate has put printers, a production run or jobs in it: the Undo says what went in and leaves the pool as it is. Every Undo in Cobblr is now checked to either refuse over a later change or say why it cannot overwrite one.

