---
type: feature
scope: scan
date: 2026-07-17
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
Re-running the lookup on a scan can now be undone. A re-run sometimes comes back worse than what it replaced (a dark photo of a tool tote re-read as a Bluetooth speaker), and until now the better answer was simply gone. The card keeps what it had before the run and offers **Put it back**.

## docs

**Re-run the lookup** asks the AI to identify a scan again, which is useful when the first pass was vague or you have a hint to add. It's also a gamble: a second look at an awkward photo can come back worse than the first one.

So the card remembers. When a re-run (or a replay) changes a scan, the Source data panel shows what it used to be, with a **Put it back** button. That restores the previous name, brand, category and suggested table in one tap, including the case where the bad run also re-routed the item to a different table.

Anything you set yourself stays put. A hint you typed, tags, the box state and your photo all survive both the re-run and the undo. Only the lookup's own answer is rolled back.

The snapshot goes one run deep, which is the depth that matters: what you want back is whatever was on screen before you tapped. Running again replaces the snapshot with that run's starting point, and once you've put it back the offer clears.
