---
type: feature
scope: scan
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
Scan a batch of similar things and they now land in ONE section instead of two near-identical ones. The session header reads "File all 3 into Clothing", and filing files them all under that. Cobblr also shows the identify which categories your workspace already uses, so it reuses "Clothing" instead of inventing "apparel" in the first place.

## docs

When you scan several things in one session, Cobblr works out a single category for the batch and shows it on the session header: **File all 3 into Clothing**. Filing from there puts every item in that one section, even when the individual items were identified with different words for the same thing ("apparel" and "clothing").

It picks the broader label when items disagree, so three t-shirts become "Clothing" rather than "T-Shirts". A category that outgrows its table can be promoted into its own later, so starting broad costs you nothing.

Two other things keep categories from multiplying:

- The identify is shown the categories your workspace already uses and asked to reuse one when it fits, rather than inventing a synonym.
- Differences of case and plural ("Clothing" and "clothing") count as the same category, not two.

Filing one item at a time still uses that item's own category, so you can always override the batch by opening a card.
