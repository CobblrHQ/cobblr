---
type: feature
scope: scan
date: 2026-08-23
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Cobblr now tells you when something goes somewhere it should not.** Put a thing that has to stay frozen into a cupboard and you hear about it straight away, rather than finding out later. It only speaks up when it actually knows how the thing must be kept, so it stays quiet rather than guessing, and it never comments on shelf-stable things. This one interrupts instead of waiting for a daily summary, because a message about food spoiling is no use tomorrow morning.

## docs

### When something goes in the wrong place

Cobblr keeps two separate facts about a grocery: how it must be kept, and where it actually is. Because they are separate, they can disagree, and that is worth knowing about.

Put something that has to stay frozen into a cupboard and you hear about it straight away, by whatever means you normally hear from Cobblr.

This one does not wait for a daily summary. Most things Cobblr tells you about food can wait until morning; a message saying your ice cream is in a cupboard cannot.

Three times it stays quiet, on purpose:

- **When it does not know how the thing must be kept.** Cobblr works this out from what an item is, and leaves it blank rather than guessing. A blank means nothing is checked, which is better than a warning that might be wrong.
- **When the thing is shelf-stable.** A jar of cumin is fine anywhere, including in the fridge. It will never be mentioned.
- **When you put something inside another thing rather than in a place.** A spare going into a toolbox is not a decision about temperature.

If you want a thing checked and it is not being, set how it must be kept on the item itself. Anything you set yourself is always used ahead of what Cobblr worked out.
