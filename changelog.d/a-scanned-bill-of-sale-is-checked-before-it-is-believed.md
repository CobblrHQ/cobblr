---
type: feature
scope: scan
date: 2026-10-02
docs_target: none (documented directly in USER_GUIDE.md, "A scanned bill of sale is checked before it is believed")
---
A scanned bill of sale is now read the way a form is and checked before it is believed: the VIN's check digit, the year against the VIN, and the money adding up. A VIN that passes names the vehicle and finds the one you already have, so a misread model line still gives "2019 Honda Civic Hatchback EX" with It's this one. When a check fails, the page goes to your AI's document reader and its answer is checked the same way, and whatever still does not add up is shown on the card to check. A name that is not words is never searched for a picture.
