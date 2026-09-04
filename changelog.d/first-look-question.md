---
type: feature
scope: core-scan
date: 2026-09-04
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The camera can now ask you. With the new First-look question switch on, a photo with no barcode gets a fast first read the moment it lands and the capture card asks "Is it X? Yes / No". Yes settles the name right away and the full read fills in the details for that item; No lets you say what it is instead and rules the guess out; ignore it and the full read runs on its own as before. The same question follows the item to the inbox, so you can answer wherever you are looking. It is off by default because it is an AI call on every photo, and the first look is its own job on the AI page so it can run on a cheaper or local model.

## docs

Turn on First-look question in the scanner's header menu (owner or admin) and a photo with no barcode gets a fast first read the moment it lands. The capture card asks "Is it X? Yes / No", and so does the inbox card. Yes settles the name at once and the full read fills in brand, category and details for that item. No lets you say what it is instead, and the full read runs with the guess ruled out. Ignore it and the full read runs on its own after a moment. A barcode scan shows its catalog entry outright; No there flags it wrong and re-checks every source. The first look is its own job on the AI page, so it can run on a cheaper or local model than the full read.
