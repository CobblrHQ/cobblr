---
type: feature
scope: scan
date: 2026-08-03
docs_target: docs/USER_GUIDE.md#Fixing a wrong identification
---
The barcode on a pending scan is now editable, a hint that names the correct barcode actually fixes it, and an added photo can drive a re-identify.

## docs

**Fix a misread barcode.** Cameras and photo-OCR sometimes read a digit wrong,
and a wrong code re-resolves to the wrong product on every re-run. The barcode
on a pending item is now editable: tap the pencil next to the code (or **Add
barcode** on a photo item that never got one), type the digits off the label
(spaces and dashes are fine), and **Save & re-run** replaces the code and
re-runs the lookup against it. The old code stays in the item's history.

**Or just say it in a hint.** A research hint that names the code - "correct
barcode 5060218983330", "the UPC is …" - now actually corrects the barcode
itself before re-running, instead of riding along as advice while the wrong
code kept answering. A bare 12-14 digit number in a hint counts too, when its
check digit proves it is a real barcode.

**Added photos can drive a re-identify.** "+ Add photo" used to attach the
picture and nothing more. Each added photo now carries a ↺ button: tap it and
the AI re-identifies the item from that photo - for when the first shot was too
dark, or you want to show the label instead of the box.
