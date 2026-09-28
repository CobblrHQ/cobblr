---
type: fix
scope: integrations
date: 2026-09-28
---
A sync no longer erases a location you set. If the source points a machine at a location the sync hasn't brought across yet, Cobblr now leaves the machine where you put it instead of clearing it, and the sync's row under Integrations says what it couldn't match. Once that location does come across, the next run picks it up. A place you made yourself before the other system had it is now matched up instead of stopping the whole locations sync, and one record the sync can't take no longer holds up the rest. Every change a sync makes to a record now also records the value it replaced.
