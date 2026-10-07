---
type: fix
scope: ai
date: 2026-10-06
---

Cobb no longer says a step was done when it failed. Asked to create a list and file things into it, Cobb could try the filing before the list existed, see it fail, make the list, and then say both were done. Now the list is made first and the filing runs once it exists, so everything lands. A step that still fails is said as not done, with its reason and a Retry. The steps Cobb took stay under the answer, open on the one that failed. A list Cobb names, like a record, is a chip that opens it.
