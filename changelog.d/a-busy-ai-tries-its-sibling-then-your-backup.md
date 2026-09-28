---
type: fix
scope: core-ai
date: 2026-09-28
---
When Google AI Studio's default model is overloaded, Cobblr now asks the other Gemini model on the same key before giving up, instead of asking the busy one nine times. The AI log names the model that was actually used rather than "default". A second AI connection that isn't used in any workspace now says so, and offers to back up your first one where it answers.
