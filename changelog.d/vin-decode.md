---
type: feature
scope: scan
date: 2026-07-13
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Enter a vehicle's VIN and the form fills in the year, make, model, and body for you, pulled from the free NHTSA lookup. It only fills fields you left blank, tags each one "filled from VIN, double-check", and one tap undoes the lot.

## docs

### Decode an identifier into fields

Some codes stand for a thing without carrying its details. A VIN is 17 characters that reference a specific vehicle, but the year, make, and model live in a database, not in the code. Scan already knows how to turn a code like this into filled-in fields, and now it does it for VINs.

On a form with a field labelled **VIN** (the vehicle bundle relabels the serial number field to "VIN" for you), type or paste a complete 17-character VIN and the form decodes it against the free NHTSA vehicle database. What it finds fills any **empty** matching fields (year, make, model, body type) and never touches a value you already typed. Each filled field gets a small "filled from VIN, double-check" tag, and a single **undo** clears the whole set if it guessed wrong. There is a **Decode** button next to the field too, for when you want to re-run it or you pasted the VIN from a title or insurance card.

If a VIN can't be decoded you get a quiet "couldn't decode that VIN" note and nothing is filled. If the lookup service is briefly unavailable it says so and you can try again. Decoding calls a US government service (NHTSA) with only the VIN. No owner or registration data is involved, and nothing else leaves your workspace. The lookup for a given VIN happens once and is remembered, so re-opening the vehicle is instant.
