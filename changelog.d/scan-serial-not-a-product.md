---
type: fix
scope: scan
date: 2026-08-10
---
**A serial number is no longer mistaken for a product code.** Scanning the label on the back of a monitor could name the item after a completely unrelated product: the serial happened to be ten characters long, which is also the shape of an Amazon product code, so it was looked up as one and a web search for the bare code returned something whose part number merely shared a few characters. Codes like that are now recognised as serials, and separately, a web guess that nothing has verified is kept as a hint rather than written as the item's name whenever there is no way to check it. Blank, with the guess offered underneath, beats confidently wrong.
