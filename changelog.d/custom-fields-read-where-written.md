---
type: fix
scope: platform
date: 2026-09-28
---
A record's custom fields now read back where they were written: an AI assistant or a script reading a record gets `board` at the top level, the same place it wrote it, instead of finding it only inside `metadata` and reporting the field empty. Assistants are also no longer told that notes or serial numbers on a collection are unreadable when they can read them.
