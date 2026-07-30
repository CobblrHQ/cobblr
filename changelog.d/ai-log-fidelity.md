---
type: fix
scope: ai
date: 2026-07-30
---

AI call details show the whole prompt and the image that was sent. Long prompts
were being cut to their first 200 characters, and vision calls stored no picture
at all. Prompts are now kept in full and images are stored as a small thumbnail.
