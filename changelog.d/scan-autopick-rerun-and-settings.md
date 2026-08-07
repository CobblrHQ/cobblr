---
type: feature
scope: scan
date: 2026-07-30
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
docs_published: 2026-08-07
---
The switch for letting AI pick your catalog photos automatically now also lives on the AI settings page, next to the connections that pay for it, instead of only as a chip in the scan header. With it on, re-running AI on an item re-picks its photo when your correction actually changed the question, so fixing a colour gets you a new photo instead of the old one.

## docs

**Pick the catalog photo with AI on every scan** is a workspace switch, off by default. You can turn it on in two places, and they are the same setting:

- **Settings, AI** has a "Scan photos" section with the checkbox and an explanation.
- The **scan inbox header** has a compact "Auto-pick photos" chip for flipping it while you work.

Both are owner and admin only, because turning it on means using AI on every scan rather than only when you press Pick best.

With it on, pressing **Re-run AI** on an item also re-picks its photo, but only when your re-run actually changed the question being asked. If you corrected the colour, that is a new question and you get a new photo. If nothing about the item changed, it keeps the photo it already chose rather than paying to answer the same question twice. It still never replaces a photo you picked yourself.
