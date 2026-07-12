---
type: feature
scope: labels
date: 2026-07-12
docs_target: docs/USER_GUIDE.md#3.2 Labels
docs_published: 2026-07-12
---
Printed labels now carry a short human-readable code (like m1, p42, b7) in the center of the QR, so you can read an item off a shelf or type it into search without scanning. Each list of things gets its own prefix and its own running count, the codes ignore case and shrug off look-alike typos (o vs 0, l vs 1) when you search, and printing warns you if a code would ever crowd the QR too much to scan.

## docs

- **Human-readable codes in the middle of the QR.** Every printed label shows a short code like `m1`, `p42`, `b7` in the center of its QR, so you can read an item off a shelf, call it out, or search for it without scanning. The code is a prefix plus a number: each **list of things** owns a prefix and its own count, so the code stays short while being unique across the whole workspace.
- **Grouping is yours to pick.** By default each list (instance) gets its own line, so a Monitors list and a Printers list count separately. Point the grouping at a field instead (e.g. category) and distinct values inside one list, like computers vs monitors inside Electronics, each get their own prefix and count.
- **Forgiving to read and type.** Codes ignore case (`m1` = `M1`), and search folds the characters people mistake for digits (`o`/`0`, `l`/`1`), so a slightly mis-read code still finds its item. Prefixes never use those look-alike letters.
- **Codes freeze once printed.** A printed sticker can't change, so renaming a prefix or moving an item later only affects new codes; the old label still resolves via its QR.
- **Unscannable-code warning.** If a code would grow big enough to crowd the QR past the point it scans reliably, printing warns you instead of quietly producing a label that won't scan.
