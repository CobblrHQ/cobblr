---
type: feature
scope: integrations
date: 2026-10-16
docs_target: docs/USER_GUIDE.md#4.5g A live sync never overwrites what you changed (`/configuration/integrations`)
---

A Part-DB part kept in several storage locations imports as one card with a place for each, with the right amount in each

## docs

A Part-DB part kept in several storage locations now arrives in Cobblr as one card with a row for each place, instead of one card pinned to its first location. Each place shows its own amount, the card's total is the sum of them, and Inventory's By place view lists each place on its own line.

The import preview says how many parts are kept in more than one place and how many places that makes. Syncing again keeps the places in step with Part-DB: a new location adds a place, an emptied one retires it, and a lot moved to another location moves only that place. A part with no storage location on a lot adds that amount to the card's own row. Part-DB's minimum is for the whole part while Cobblr's is per place, so a part kept in several places leaves its minimum empty and keeps Part-DB's value in its details.
