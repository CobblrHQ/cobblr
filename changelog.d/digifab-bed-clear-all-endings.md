---
type: fix
scope: digifab
date: 2026-08-05
---
A printer now waits for you to clear the bed no matter how the print ended. Cancelling a running print, removing a connection, or a failed handoff to the machine used to skip the bed-clear step that a normal finish triggers, so the next plate in the queue could be sent to a printer that still had the abandoned one stuck to it. A cancelled print also gets its own wording on the printer card, and does not ask whether the part came out good, because there is no finished part to judge.
