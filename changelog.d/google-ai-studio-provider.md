---
type: feature
scope: ai
date: 2026-08-20
docs_target: docs/modules/core-ai.md#Built-in providers
---
Connect a free Google AI Studio key to power scanning, image identification, chat and tool calls, without pasting a base URL.

## docs
Cobblr can now use Google AI Studio's free tier as an AI provider. Pick **Google AI Studio (free tier)** when adding an AI connection, paste a key from aistudio.google.com/apikey, and leave the model blank to use a model with a usable free daily allowance. A key is free and needs no card and no Google Cloud project.

One key covers everything Cobblr asks a model to do: reading a label or ball band in the scan inbox, identifying an item from a photo, chat, and running tools.

The free tier's daily allowance differs a lot between models: the default gives you 500 requests a day, while the stronger Flash model gives 20. If the AI stops answering, that cap is the first thing to check.

Note that Google may use free-tier input to improve their products. Their paid tier does not. If that matters for what you photograph, use a paid key, another provider, or run a local model with Ollama, which sends nothing anywhere.
