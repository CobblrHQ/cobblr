---
type: fix
scope: scan
date: 2026-09-06
---
The picture retry stops asking about items that already have a picture, and
when the picture search refuses a request it waits an hour before asking
again, so the retry itself no longer keeps the search blocked.
