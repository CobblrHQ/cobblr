---
type: feature
scope: ai
date: 2026-08-20
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
"Delete duplicates" now covers parts as well as places, and any other kind whose module says what "the same place" means for it. Two shelves with one name in one rack are duplicates; the same two in different racks are not. Two identical parts in one bin are a double entry; the same name in two bins is two piles of bolts. A kind that has not said how to read it is never touched, because two assets called "Drill" are usually two drills, and guessing otherwise is how an assistant deletes something you meant to keep.

## docs
Cobb can clear duplicates in any list whose module has said what counts as "the same place" for it. Places are scoped by what they are inside, parts by the bin they are filed in. So two "Shelf 1"s in the same rack are offered for removal, and the same two in different racks are left alone. Kinds that have not declared a reading, like assets, are never deduplicated at all: two of the same name there are usually two real things. The offer names each kind separately ("1 duplicate location, 1 duplicate part") so you can see what it means before accepting.
