---
type: feature
scope: core-scan
date: 2026-09-25
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
A photo of a label now fills in its item. Photograph a bulk bag or a lot sticker after scanning the item and the count, lot, colour, SKU and case code printed on it are written onto that item, marked as read from the label. Anything you typed yourself stays yours, and combining a case label with one of its items counts the case once.

## docs

**A label photo fills in its item.** Any extra photo you add to an item is read
as well as kept. When it shows a label, what the label prints is written onto
the item: how many ("quantity contained 3", "pack of 6", "24 ct"), the lot, the
colourway, the SKU, and a case code as the pack code. Each value is marked as
read from the label, and a value you typed yourself is never replaced. The
capture screen sums it up in one line, for example "Charisma Yarn, Dark Blue ·
lot 6127 · ×3".

A photo of a bulk bag reads its own count the same way, so a bag labelled with
three skeins is ×3 rather than ×1. Combining a case label with a scan of one
item inside it gives the case count, not the case plus one.
