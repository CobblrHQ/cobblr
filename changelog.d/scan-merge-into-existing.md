---
type: feature
scope: scan
date: 2026-07-16
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Scan something you already track and Cobblr now asks "is this the same one?" and offers to merge what the scan learned into the existing record, instead of only offering to add a duplicate. Snap a license-plate photo of a car you first added by its VIN and it fills in the plate and color on that car. Only fields the record is missing get filled, so nothing you already had is overwritten. (This also fixes the match that powers it: a scan named "Honda Civic Hatchback" now finds your "2019 Honda Civic", where before the two names had to overlap almost word-for-word.)

## docs

When a scan matches something you already have, the triage card shows a green "already tracked" banner so you don't make a duplicate. Matching works two ways: an exact barcode, or an overlap of significant words in the name (so "Honda Civic Hatchback" finds your "2019 Honda Civic").

You don't have to open the card to find out. When a scan matches something you own, the closed card says so on its own line and names it ("You already have 2019 Honda Civic. Is this the same one?"), with a **Compare & merge** button that opens the card. The one-tap **Add** isn't offered on those cards, because adding is the duplicate you're trying to avoid.

For a one-of-a-kind thing like a vehicle or a tool, the banner asks **"Is this the same one?"** and lists the details this scan learned, for example a license plate and color read off a photo. Tap **Yes, merge these in** and those details are written onto the record you already have, filling only the fields that were still blank. Nothing you already entered is overwritten, and no second copy is created. If it's a different item, dismiss the banner and add it as new.

For everyday stock (parts, supplies) the same banner instead offers **+N to it** (add this scan's quantity to the count you already track), **Move here** (file it into the bin you're standing at), or **Link barcode** (teach an existing item the barcode you just scanned so the next scan matches instantly).
