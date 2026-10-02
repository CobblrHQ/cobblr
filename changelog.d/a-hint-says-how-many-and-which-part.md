---
type: feature
scope: scan
date: 2026-10-02
docs_target: docs/USER_GUIDE.md#Re-running the AI on an item
---
A hint like "8x S-12415" on a scanned card now sets the count to 8 and looks up S-12415 itself: the card is renamed to what the part number is, its picture is searched for by the part number, and if nothing is found the part number is kept as the model number. Scanning the same part number in another place offers Add as another place, so eight bins in the kitchen and four in the garage are one item with a row for each place, never a second item. The photo search no longer picks up words for what is inside or beside the thing, like the roll of tape in a stack of bins.

## docs

**A hint can say how many and which part.** Before the AI reads a hint, Cobblr reads its shape:

- A count, written as `8x`, `x8`, `8 ×`, `qty 8` or `8 pcs`, sets the card's count, as yours. A hint that is only a count does not re-run the AI at all.
- A part or model number (letters and digits, like `S-12415`) is looked up for itself, the way a scanned barcode is. When the web agrees on what it is, the card is renamed to that (a name you typed yourself still wins, and **Previously: … · Revert** brings the old one back), and the picture is searched by the new name and the part number. When nothing is found, the card says "Couldn't find S-12415; kept it as the model number", keeps its name, and the count still lands.

Whatever else the hint says is still handed to the AI as before.

**The same part in another place.** Once something is filed with its part number, scanning it in another place finds it by that number, whatever the new card is called. The card says "You already have Storage Bin: 8 in Kitchen. Add these as another place?", and **Add as another place** adds a row for this place, with its own count, under the same item. The kitchen's count is left alone, and undoing the filing removes the new place's row.
