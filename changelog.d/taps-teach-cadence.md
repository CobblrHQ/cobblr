---
type: feature
scope: inventory
date: 2026-09-08
docs_target: docs/USER_GUIDE.md#3.1 Inventory
---
**Every tap on an item now teaches how fast you go through it, and there is a one-tap "Replaced with a fresh one".** Use one, Used up, Finished it, Threw it out and Restock one used to change the count and teach nothing about cadence; only a scan or a shopping-list tick did. They all feed the consumption ledger now. And when you run out of something and put an identical new one in its place, **Replaced with a fresh one** records both facts in one tap: the count stays the same, the old one ends as used, the new one is dated today, and the ledger learns the interval.

## docs

**Taps that teach.** The one-tap marks on an item, **Use one**, **Used up**, **Finished it**, **Threw it out** and **Restock one**, change the count and, with Cadence enabled, also tell the consumption ledger what happened (used, thrown away, bought). That is how "replenish every N days" and "days until you run out" learn from ordinary use, not only from scans and shopping-list ticks. **Replaced with a fresh one** is for the everyday swap: you finished a box and put an identical new one in its place. One tap records the old one as finished (a floor on its shelf life), dates the new one today, leaves the count exactly where it was, and tells the ledger one was used and one was bought, which is the interval it measures. Nothing here fires a running-low alert, because nothing ran low.
