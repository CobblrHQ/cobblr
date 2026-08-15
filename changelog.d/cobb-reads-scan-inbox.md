---
type: feature
scope: core-scan
date: 2026-08-14
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Ask Cobb can now see the items in your scan inbox, not just the count: ask what is waiting, what needs a look, or what has been sitting there for days, and he reads the actual queue.

## docs

**Ask Cobb can read the queue itself.** Cobb used to see only the one-line summary the Scan page publishes ("148 pending, 36 waiting 2d+, 15 need review"), so "can you see the items in my scan inbox?" got an honest no. He now reads the items: ask "what is in my scan inbox?", "which ones need a look?", "what has been sitting there the longest?", or "did I scan a belt for the lathe?", and he answers from the queue itself.

For each item he can see what it was identified as, its brand and barcode, whether it came from a barcode, a photo, a typed note or a receipt line, how many days it has been waiting, whether it still needs a human, what filing it would create, and whether it already has somewhere to go. He can narrow to the same four groups the page's header filters by: **needs review** (no clean name, a shaky lookup, or low confidence), **waiting** (sitting more than two days), **unfiled** (no destination yet), and **ready** (has a destination and nothing left to ask). Counts come from the whole queue rather than the first page, so "you have 15 that need a look" means fifteen, not fifteen out of however many he happened to read.

Those groups are now defined in one place for the whole product, so the number in the Scan page's header, the group you filter to, and the answer Cobb gives are always the same answer. Two spots on the Scan page had drifted from it and are fixed as part of this: a photo tile kept its amber "needs a look" border after you had marked the item *Looks fine*, and a card could disagree with the header about whether a rate-limited item still needed review.

Reading the inbox obeys the same **Read my data** switch as everything else Cobb reads, and it stays read-only: filing, discarding and editing still happen the way they always have.
