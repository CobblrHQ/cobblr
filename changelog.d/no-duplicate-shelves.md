---
type: fix
scope: locations
date: 2026-08-20
---
Two things in one place can no longer end up with the same name by accident. Asking the assistant to give every rack "Shelf 1 through 5" in a room where one rack already had a Shelf 1 used to add a second one and report it as done; now that create is refused, the refusal says which shelf is already there, and the assistant tells you rather than duplicating it. The same name in a different place is fine as always, renaming onto a sibling's name is refused too, and a deliberate second "Bin" is still available with allow_duplicate.
