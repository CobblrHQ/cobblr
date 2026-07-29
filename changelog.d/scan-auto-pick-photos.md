---
type: feature
scope: scan
date: 2026-07-29
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
You can now have Cobblr pick catalog photos with AI on every scan instead of pressing the button each time. Turn on "Auto-pick photos" in the scan header and each newly identified item gets the cleanest product shot chosen for it. It stays off until you turn it on, never replaces a photo you chose yourself, and never pays twice for the same item.

## docs

The ✨ Pick best (AI) button picks one item's photo when you press it. If you would rather not press it every time, the scan page header has an **Auto-pick photos** switch (owner and admin only). Turn it on and every item Cobblr newly identifies gets its catalog photo chosen the same way, with no tapping.

It is off until you turn it on, because it uses AI on every scan rather than only when you ask. Once on, it is careful about when it actually spends:

- It never replaces a photo you picked yourself. Your choice always wins.
- It never pays twice for the same item. If you re-run AI on something and the answer comes back as the same thing, it keeps the photo it already chose; if the re-run decides the item is something different, it picks again for the new answer.
- It skips items you have already filed or discarded, items with no name yet, and items where the search only found one photo (there is nothing to choose between).

It needs an AI provider configured under Settings, AI, and it respects the workspace AI kill-switch and your credit limits like every other AI feature. You can see it working, and turn the automation off separately, on the Wires page: it runs as a wire called "Pick the best catalog photo". Turning the switch off is the simplest way to stop it.
