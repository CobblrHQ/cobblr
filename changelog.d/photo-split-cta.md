---
type: feature
scope: core-scan
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Photograph a pile of different things and the inbox now asks what you want done with them.** Snap two humidifiers, or a shelf of mixed gear, and the card says "2 different items in this photo", names them, and offers a choice right there on the closed card: keep them together as one record, or split into individuals. Splitting gives each one its own entry, cropped out of your photo where possible, and each goes and finds its own product image by name, so you get real records rather than fragments of a group shot. This costs no extra AI: the pass that reads every scanned photo was already counting the units it could see, and now it names them too. A pile of the **same** thing still counts as a quantity, so a sealed ten pack of screws will not ask you to split anything. There is still a manual **Split into items** button in the expanded card for the times you disagree with it.

## docs

### When one photo has several different things in it

Photograph two humidifiers, or a shelf of mixed gear, and the inbox card tells you so:

> ✨ **2 different items** in this photo. Keep them together as one record, or split into individuals?
> · Crane Penguin Humidifier
> · Crane Frog Humidifier
> [ Split into 2 items ] [ Keep as one ]

**Split into N** creates a separate inbox entry for each one. Where the AI can locate an item in the frame, that entry is **cropped** to just that item; where it cannot, the entry keeps the group shot. Either way, each entry then searches for its **own product image by name**, so a split leaves you with proper records rather than several copies of the same group photo. Each one runs the normal identification pass, so it lands in the right table with its own fields.

**Keep as one** files it as a single record and stops asking.

Two things worth knowing:

- **Several of the same thing counts as a quantity.** A sealed ten pack of one screw, or three identical mugs, is one item with a quantity of ten. The offer only appears when the things are *different* from each other.
- **It costs nothing extra.** The pass that reads every scanned photo was already counting the units it could see; now it names them as well, in the same call. The more expensive step that draws boxes around each item only runs if you actually choose to split.

If you disagree with it, the expanded card still has a manual **✂ Split into items** button.
