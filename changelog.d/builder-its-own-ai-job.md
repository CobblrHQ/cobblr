---
type: feature
scope: assistant
date: 2026-09-08
docs_target: docs/modules/ai-bundle-builder.md#The builder has its own AI job (2026-09-08)
---
Building a workspace from a description is now its own AI job, so you can put it on a stronger model than the one answering everyday questions and see what it costs on its own. On the free Google tier it already defaults to the fuller model, which is capped at 20 requests a day: hopeless for chat, and plenty for a builder you run a handful of times.

## docs

"Build a workspace from a description" is a separate row on the AI settings page, with its own provider and model. Pick a bigger model there than you would want answering every chat message: the builder runs a handful of times per workspace, and its answer is what you either recognise as your own things or don't.

If you connected Google AI Studio and left the model field blank, the builder already uses the stronger model while everything else stays on the light one. Typing a model on the connection uses that model for everything instead. Nothing changes for a workspace that has not chosen: the builder keeps working exactly as it did.
