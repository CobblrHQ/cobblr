---
type: fix
scope: core-scan
date: 2026-07-14
---
**Combining two scans of the same thing now keeps what each of them saw.** The scanner can capture one object two ways and produce two entries: reading a code gives you the identity but not the colour, while a photo of the same object gives the colour but not the code. Combining them used to keep one entry and throw the other's details away. Now the combine keeps whichever entry has the stronger identity and fills in its blanks from the other, so you end up with everything that was learned in one record rather than losing half of it. Your own entry's values are never overwritten; the other entry only fills gaps, and only from an entry that was headed to the same table.
