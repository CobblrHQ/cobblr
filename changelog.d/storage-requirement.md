---
type: feature
scope: scan
date: 2026-08-22
docs_target: docs/USER_GUIDE.md#How something must be kept
---
**Scanned food now records how it needs to be kept, separately from where it is.** Frozen, refrigerated or ambient, worked out from what the item is. That is a fact about the product; where it currently sits is a different fact and stays on its location. Keeping them apart means Cobblr can eventually tell you when they disagree. Anything you set yourself always wins, and nothing is guessed when the item does not say.

## docs

### How something must be kept

Two different facts about a grocery get muddled easily, so Cobblr keeps them apart:

| | |
|---|---|
| **How it must be kept** | a property of the product: frozen, refrigerated, or ambient |
| **Where it is** | its location, which you can label and scan things into |

Scanning food fills in the first one where it can, from what the item is. A bag of frozen peas is frozen wherever it happens to be sitting; a jar of cumin is ambient even if you keep it in the fridge.

Three things worth knowing:

- **Anything you set yourself wins.** The scan only fills a blank.
- **Nothing is guessed.** If an item does not say enough about itself, the field is left empty rather than assumed shelf-stable. An empty answer is honest; a wrong one would be worse than none.
- **A product's form counts.** Garlic powder is ambient even though garlic is not, and canned fish is ambient even though fish is not.

Because the two facts are separate, they can disagree, and that is the point: something that must stay frozen sitting somewhere that is not a freezer is worth knowing about.
