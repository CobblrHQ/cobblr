---
type: fix
scope: assistant
date: 2026-09-17
---
**An action that did nothing no longer reports success.** Pressing an action on a record that no longer exists, or asking for one with nothing to go on, could answer with a green tick while nothing happened, or create an empty item, order or purchase order. Now the action refuses and says why: the record is not there, or what it needs. Recording machine usage by hand adds no print you did not mention; a wire that fires on a finished print still counts it.
