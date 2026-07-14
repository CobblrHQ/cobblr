---
type: fix
scope: core-scan
date: 2026-07-14
---
Two fixes to the scan inbox's bulk-select toolbar. It is no longer see-through (you could read the cards through it) and it is tighter, so it takes one action row on a phone instead of wrapping to three: Discard and clear are icons now, and the labels are shorter. And a card now shows where it is being filed. Setting a location on selected items writes their filing bin, but the card only ever showed the location a bundle's AI happened to guess (a Home Inventory item's `room`), so "Set location" looked like it did nothing. The bin you chose now shows on the card with a pin, distinct from any guessed field.
