---
type: feature
scope: scan
date: 2026-08-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**One button files everything waiting, adding to what you already have instead of making a second one.** A receipt saying three cucumbers now finds the cucumbers already in your kitchen and adds to them. It shows you what it would do before it does anything, and anything it cannot tell apart is left for you rather than guessed at.

## docs

### Filing a whole inbox at once

Scanned things wait in the Scan Inbox until they are filed. Filing them one at a time is fine for a few and tedious for a shop.

**File everything** looks at everything waiting and sorts it into three piles:

| | |
|---|---|
| **Added to what you have** | it recognised the item, by barcode or by name, and increased the count rather than creating a second one |
| **Filed as new** | nothing like it yet; if the table it names is one you do not have yet (a first receipt of groceries before Groceries is installed), the line says **installs it first** and confirming installs it on the way, once. Only an owner or admin can install, so for anyone else that line waits in Left for you and says who can |
| **Left for you** | it could not tell, and says why |

It always shows you the plan first. Nothing is written until you confirm, and Confirm files exactly the lines you were shown; a line whose plan changed between the look and the press is left alone and named. Afterwards every filed line has an **Undo**, and there is an **Undo all**. The button lives on a receipt session's row and, for the whole inbox, in the inbox's ⋯ menu.

**Anything ambiguous is left alone on purpose.** If a receipt line could be any of three teas you already have, no machine can tell which, and attaching it to the wrong one would quietly inflate the stock of something you did not buy. Those stay waiting for you, which takes a second each.

A barcode beats a name, because a barcode is the product saying what it is and a name is an opinion about it.
