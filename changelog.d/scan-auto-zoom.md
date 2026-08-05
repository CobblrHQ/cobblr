---
type: feature
scope: scan
date: 2026-08-05
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The scanner zooms in by itself when a barcode is too small in view to read, so a code across the room or on a low shelf no longer means walking closer. It uses the position it already works out while trying to read the code, steps gently rather than snapping, holds still while codes are reading, and widens back out when there is nothing in view, since a narrow view makes finding a code harder. Setting a zoom by hand in the URL turns it off.

## docs

Covered in the User Guide scanner section: automatic zoom for codes that are small in frame, the step and back-off behaviour, that it never moves while a code is reading, and that a manual `?zoom=N` disables it. The `?diag=1` readout gains an auto zoom row.
