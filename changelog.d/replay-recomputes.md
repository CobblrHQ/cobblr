---
type: feature
scope: scan
date: 2026-08-12
docs_target: docs/USER_GUIDE.md#Replay
---
**Replay now means "re-apply the latest processing", and it can no longer make an item worse.** What the AI works out about an item (its name, brand, category, what the photo shows) is stored on the item. Everything after that (which table it belongs in, which fields fill, the pack size, a decoded serial, the catalog photo) is worked out from that stored answer by Cobblr's own code. Replay redoes the second half with the code as it is today and never touches the first, so it costs nothing, returns immediately, and has no new information to overwrite anything with. Previously it re-asked the AI for a copy of an answer it already had, and when that copy could not be found, degraded to a keyword guess that could overwrite a good name with a worse one. Use it to bring an item you scanned last month up to date with an improvement that shipped since. Re-run AI is still the one that takes a fresh look. Scan names that an earlier replay truncated are restored automatically.

## docs

The Replay section of the user guide is rewritten. The button is now called **Replay** rather than "Replay (no AI)", and the guide explains the split it depends on: the AI's read is stored on the item, and Replay recomputes only what Cobblr derives from that read. It states plainly that Replay cannot make an item worse, that it will not produce a new identification, and the one limit worth knowing, which is that a bundle installed after an item was scanned is not discovered by a replay (that is what Re-run AI is for). The old "nothing cached to replay" paragraph is gone, because there is no longer such a state.
