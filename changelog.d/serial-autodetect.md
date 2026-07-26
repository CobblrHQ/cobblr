---
type: feature
scope: print
date: 2026-07-26
docs_target: docs/USER_GUIDE.md#Print labels over Bluetooth
---
Connecting a serial label printer now detects the loaded roll size automatically, so there is nothing to fill in.

## docs

**Connecting a serial printer takes one click.** Pick the port and Cobblr asks the
printer what it is and what roll is loaded, then fills in the command language and
media for you. Nothing to measure, nothing to type.

The roll size comes from the code printed on the media itself, so it is whatever
is loaded **right now** rather than something you configured once and have to
remember to change. Swap to a different roll and the printer reports the new size.

If a printer does not answer, nothing is lost: Cobblr says so and you fill in the
dialect and media by hand as before.
