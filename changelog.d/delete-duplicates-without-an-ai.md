---
type: feature
scope: ai
date: 2026-08-20
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
"Delete duplicates" now works with no AI connected. Cobb looks for places with the same name in the same spot, tells you what he found ("Delete 2 duplicate places (Shelf 1, Shelf 2), keeping the original of each"), and does it only once you accept. Pointing at something first scopes it, so with a rack selected it means the shelves in that rack rather than everything you own. The removals are tracked and undoable like any other change. And when you press enter for the AI instead of taking the free offer, the assistant is now told what that offer had already worked out, so it does not go and solve the same problem from scratch or ask a question the offer had answered.

## docs
Some jobs cannot be taught as a phrase with blanks to fill in, because what they do depends on what is there. "Delete duplicates" is one: Cobb looks for places with the same name in the same spot, says exactly what he would remove and what he would keep, and waits for you to accept. It needs no AI. If you have ticked or highlighted something first, that scopes the search, so with a rack selected it means the shelves in that rack. What it removes is tracked and undoable like any other change, and asking again when there is nothing to find says so rather than offering an empty change. When a free offer matches but you press enter for the AI anyway, the assistant is told what the offer found, as information: it can do the same thing, or explain why it is doing something else.
