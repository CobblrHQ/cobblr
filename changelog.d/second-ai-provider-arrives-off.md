---
type: fix
scope: ai
date: 2026-08-26
---
Adding a second AI provider to a workspace no longer silently switches every AI call over to it. The first provider you connect is used straight away; any you add after that arrive switched off, and the confirmation says so, so you turn one on when you mean to.
