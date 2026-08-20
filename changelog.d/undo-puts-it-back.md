---
type: feature
scope: ai
date: 2026-08-20
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
Undo now puts things back rather than doing the opposite. A record Cobb deleted comes back as itself, with its own id, so everything filed inside it or pointing at it is pointing at it again; before, a lookalike was created with a new id and the old links were left dangling. An edit is reverted in full, including fields the change touched indirectly, and if something else edited that record in the meantime you are told rather than having it quietly rolled back too. Undoing a whole instruction is one request now: "each rack should have Shelf 1 through 5" goes back in one press, in seconds.

## docs
Every change Cobb makes records the record's whole state before and after, so undo is a restore, not a reverse operation. A deleted record comes back as the same record, with the same id, so children, labels and anything filed under it still point at it. An edit is put back in full, not just the fields the change happened to name. If someone (or something) else changed that record after Cobb did, the undo tells you it rolled that back too, and can itself be undone. And a whole instruction is one thing to take back: the Undo beside "Added 58 locations" puts all 58 back in a single request.
