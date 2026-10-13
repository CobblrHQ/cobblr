---
type: fix
date: 2026-10-13
scope: inventory
---
A title with a word like None or Null in it is kept whole ("None of the Above" is no longer saved as "of the Above"). Only empty values after a label such as "SKU: None" are cleaned out of a name. Titles the earlier cleanup cut are put back from the name they were created with.
