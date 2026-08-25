---
type: fix
scope: ai
date: 2026-08-25
---
A local Ollama model is now given a context window big enough for Cobb's tools. It was being sent more than the default window holds, so the tool list was silently cut out of the prompt and answers stopped mid-sentence: on a real box this took one model from 1 of 8 tasks to 6 of 8, with no change to the model.
