---
type: feature
scope: inventory
date: 2026-08-23
docs_target: docs/USER_GUIDE.md#3.1 Inventory
---
**Cobblr can now work out how long your things keep, from what you tell it you did.** You do not need to know that a jar of pesto lasts five days once opened. Mark it opened when you open it, and mark it thrown out if it goes off, and after a couple of jars Cobblr knows. Finishing something never counts as a measurement, because eating it early proves nothing about when it would have gone bad, so the figure is only ever learned from things that actually spoiled.

## docs

### Letting Cobblr work out how long things keep

Nobody knows the shelf life of a jar of pesto. But you know what you did with it, and that is enough.

Three marks on an item, each recording the day you tapped it:

| | |
|---|---|
| **Opened** | starts the shorter clock on that one. The unopened ones keep their own dates |
| **Finished it** | you used the last of it up |
| **Threw it out** | it went bad |

After a couple of jars, Cobblr can date new ones for you and warn you before the next one goes off.

**Only throwing something out teaches the shelf life.** If you finish a jar in a week, that tells Cobblr the jar lasted at least a week, not that a jar lasts a week. Treating those the same would mean somebody who eats quickly gets warned about food that was never going to spoil, so finishing something only ever raises the floor.

Until something has actually gone off, you will see "lasted at least 3 weeks so far" rather than a shelf life. That is Cobblr being honest about what it has seen, and it is better than a number it made up.

One jar going off is treated lightly; two that agree are taken as a pattern and used to date what you buy next.
