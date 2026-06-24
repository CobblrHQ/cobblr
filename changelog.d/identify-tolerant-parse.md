---
type: fix
---
Photo identification now succeeds when the vision model returns a richer result shape. It was identifying items correctly (e.g. a screen-protector package as brand/product line/product name) but the scanner only read a strict "name" field, so a correct identification surfaced as "no vision provider configured." It now pulls a usable name from the richer shape too, and a re-run forces a fresh look (bypassing any result cached under an older prompt).
