---
type: feature
scope: core-scan
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Re-running the AI on a photo now finishes when it says it finishes.** Reading a photo used to take three model calls in a row, and the card went quiet after the first one. The name would update, the spinner would stop, everything looked done, and then several seconds later a "2 different items, split?" offer appeared out of nowhere. It read like a bug. Now the pass that identifies the photo answers all three questions in a single read, so the name, what it saw, and the split offer all land together, and the spinner keeps going until the whole chain is actually finished. That is also one fewer vision call per photo. A re-run has stopped **erasing** things, too: it used to wipe the split offer and then pay to rediscover it, and if you had answered "keep as one", it threw your answer away and asked again. There is also a new **Replay (no AI)** button that re-runs everything except the model calls, which is free, instant, and useful when the identification was fine but Cobblr's handling of it was not.

## docs

### Re-running the AI on an item

**Re-run AI** re-reads the item from scratch. Add a **research hint** first ("it's the 5 mm one", "the model number is X") and it treats that as a correction that overrides what it thought it saw.

While it works, the card shows a reading indicator. That indicator stays up until the whole pipeline is done, meaning it has identified the item *and* chosen which table the item belongs in. It no longer stops as soon as the name appears. If the name changes and the indicator is still going, more is still on the way.

### Replay (no AI)

Next to Re-run AI sits **Replay (no AI)**. It re-runs everything *except* the model calls, reusing the answer the AI already gave for this photo.

Use it when the AI's read was fine but something about how Cobblr *handled* that read was not: the item landed in the wrong table, a field did not fill, a pack size or a serial number was not picked up. Replay redoes all of that against the AI's existing answer. It is free, it spends no AI credits, and it comes back almost immediately.

It is **not** a way to get a better identification. It reuses the previous answer instead of asking for a new one, so if the AI misidentified the item, Replay will faithfully misidentify it again. Reach for **Re-run AI** instead, ideally with a research hint. Typing a hint hides the Replay button for exactly this reason: a hint is new information, and new information needs a real read.

If an item has never been read successfully, or its photo has been replaced since it was, there is nothing cached to replay. The card says so rather than pretending to work.
