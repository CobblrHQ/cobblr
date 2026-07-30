---
type: feature
scope: scan
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The colour now shows up in the item's name, not just in the photo search. An identified shirt reads "…T-Shirt, Black", and if you correct the colour the title is corrected too instead of keeping the old one. Brand names that contain a colour, like Red Heart yarn, are left alone. Separately, every AI job on the settings page now has a plain English name instead of falling back to its internal id.

## docs

When Cobblr knows an item's colour, it puts it in the name: "Under Armour Icon Charged Cotton SS T-Shirt, Black". The colour comes from your hint first, then the item's own colour field, then what the AI could see.

If the name already carries the wrong colour, correcting it fixes the name too. Say the title reads "Blue Icon T-Shirt" and you hint "color: black"; after a re-run it reads "Black Icon T-Shirt" rather than keeping a colour that contradicts the photo next to it.

Brand names are protected. "Red Heart Super Saver Yarn" in blue becomes "Red Heart Super Saver Yarn, Blue", never "Blue Heart Super Saver Yarn", because the brand's colour word is part of its name.
