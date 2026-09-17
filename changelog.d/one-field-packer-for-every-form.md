---
type: feature
scope: platform
date: 2026-09-17
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Every form of fields, on a record page and on the scan item screen, lays itself out from what each field needs and how wide the screen is: two short dropdowns share a row on a phone, a date gets a column it fits, a note takes the row, and nothing overlaps or runs off the edge. A compact card never prints the same value twice and every field label reads as words.

## docs

**Fields pack themselves.** A record page's custom fields and the scan item screen's form no longer use a fixed two-column grid. Each field asks for the room its control needs (a dropdown as wide as its longest choice, a date wide enough for its picker, a checkbox almost nothing, a note the whole row) and the form packs them in their declared order into as many columns as the screen holds: two on a phone, up to four on a desk. Built-in fields and the fields you define are packed together by the same rule; nothing overlaps and nothing sits off the edge of a phone, which is what a fixed grid did to two date fields side by side.

**Compact cards say each thing once.** On the scan inbox's compact cards a value the title line already prints (an ISBN, the brand, the shop) is not printed again as a field, and a field with no display label reads as words ("Set number", "ISBN"), never as its internal name.
