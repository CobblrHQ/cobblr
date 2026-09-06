---
type: fix
scope: scan
date: 2026-09-06
---
When the picture search is refusing requests for a while, an item now says the
search is busy and tries again by itself, instead of reporting that no picture
exists. Fresh food is searched for without the shop's name, which had been
pulling in the shop's own tinned goods: baby carrots came back as a tin of peas
and carrots. Searches are spaced out so a long receipt no longer gets the
service blocked.
