---
type: feature
scope: digifab
date: 2026-06-18
---
**A finished print no longer closes your task until you confirm it came out good.** A printer reporting "completed" only means the gcode finished, not that a good part is on the bed (it could be spaghetti). So Cobblr now treats the after-effects by how much it hurts to get them wrong: your **filament count and machine hours still update the moment a print finishes** (cheap to undo), but **closing the to-do that print was for now waits for your verdict.** When you clear the bed, you tap **Came out good**: which closes the linked task, or **Scrapped**: which puts the filament and the machine usage back and leaves the task open. In the normal good case it's one tap you were already making; the one thing that used to silently go wrong on a failed print (a task marked done that wasn't) no longer can.
