---
type: feature
scope: scan
date: 2026-07-29
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
The scan inbox can now pick your catalog photo with AI. Tap "Pick best (AI)" on an item's photo options and a vision model looks at every candidate and chooses the cleanest one: the product by itself, in the right colour, with no people in the shot. The free photo ranking also got better at colour, so an item you know is black stops surfacing a red one.

## docs

The photo options strip under an inbox item now has a **✨ Pick best (AI)** button. Press it and Cobblr shows the candidate photos to a vision model and asks it for the single best catalog picture, in this order of priority:

1. The product on its own, with no person, hand, or face in frame, and no photo of just the tag or packaging.
2. The correct colour. This is the thing the AI weighs most, and it uses your own scan photo as the colour reference when there is one.
3. A clean studio look over a lifestyle shot.

The one it picks gets a ✨ badge and becomes the item's catalog photo, with a one-line note on why it chose it. If you disagree, tap any other photo to override it. The button uses more of your AI allowance than the normal ranking, so it runs only when you press it (there is no per-scan cost otherwise). It needs an AI provider configured under Settings, AI; without one, the free ranking still runs and the button tells you it has nothing to call.

Even without the button, the free ranking that orders the photo options now understands colour: when your item records a colour, a photo whose title names that colour is preferred and one naming a different colour is pushed down, so the wrong-colour variant stops winning on its own.
