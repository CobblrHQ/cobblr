---
type: feature
scope: core-scan
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: none (a split pack's lines already say where their colours came from; nothing new to press)
---
A mixed pack someone has filed is known to the next person who orders it, so their order splits into its spools with no AI.

## docs

**A pack someone filed is known to the next person.** When every spool of a mixed pack you ordered is filed with its colour, what the pack held is shared with the barcode network as a fact about the store's product: the store, the product, which pack, and each spool's colour and part number. It carries no name, workspace, price or photo. The next person to order the same pack gets it split into its spools straight away, with no AI reading the pack's photo, and each spool says whether one person or several confirmed it. Two people who filed it differently cancel each other out, and the photo is read as before. A self-hosted Cobblr shares nothing unless whoever runs it connects it to the network.
