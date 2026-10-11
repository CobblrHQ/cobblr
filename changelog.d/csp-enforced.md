---
type: security
scope: platform
date: 2026-10-11
---
Cobblr's pages now enforce a strict Content-Security-Policy, so a script injected into a page can no longer run or send your session anywhere; every source the app really uses (fonts, the signup captcha, file previews) is named, and anything refused is reported to the server.
