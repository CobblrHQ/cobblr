---
type: feature
scope: scan
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Corrections now build on each other instead of replacing each other. Tell Cobblr "color: black" and later "it's the loose fit" and it keeps both. Tell it two different colours and the newer one wins. The AI is shown everything you have said about the item, in order, and told that the most recent correction is the strongest.

## docs

Research hints stack up. Every correction you give an item is kept, and the identify is shown all of them in the order you gave them, with the newest marked as most recent.

That means two things:

- **If two hints disagree**, the newer one wins. Say "color: black" today and "color: navy" tomorrow, and Cobblr treats it as navy; the older correction is obsolete.
- **If two hints are about different things**, both keep applying. Say "color: black" and later "it's the loose fit", and it still knows the colour is black. Correcting one detail never wipes another.

The item's history shows which runs used a hint and what it was, so you can see everything Cobblr is currently going on. Only the last few corrections are carried, so an item you have corrected many times keeps the recent ones.
