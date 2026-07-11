---
type: fix
scope: platform
date: 2026-07-11
---
AI features that quietly ignored your connected AI now use it. Several AI calls (scan identify, receipt reading, web-search product lookup, pattern extraction, template matching, catalog matching) were not telling the AI layer which user was asking, so a personal AI connection routed to just you would not resolve and the feature fell back to no-AI. All of these now pass the requesting user, so your bring-your-own AI is used everywhere it should be. A new build check (`lint:ai-invoke`) keeps it that way: every AI call must pass the user, or be explicitly marked as a background job, so this whole class of "why is there no AI here" bug can't come back.
