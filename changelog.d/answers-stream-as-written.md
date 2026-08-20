---
type: feature
scope: ai
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
Cobb's answers now appear as they are written, a few words at a time, instead of the whole thing landing at the end of a long wait. A reply that takes ten seconds starts showing up after three. This works with a self-hosted Claude bridge, which now streams from the CLI for real rather than waiting for the whole answer and sending it in one piece, and with any other provider whose API streams.

## docs
While Cobb writes, the words appear in the panel as he produces them, under the list of what he has already done. A reply that takes ten seconds starts showing after about three, so a long answer stops looking like a hang. Streaming happens when the provider supports it and the turn is a plain answer rather than one that is calling tools, since a half-arrived tool call is not something to show. **Self-hosting with the Claude bridge?** It now streams from the CLI for real. Older bridges waited for the whole answer and then sent it in a single piece, which looked like streaming to the app and like a long silence to you, so update the bridge to get this.
