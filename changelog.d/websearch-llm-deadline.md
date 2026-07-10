---
type: fix
date: 2026-06-22
---
The barcode web-search no longer "gives up" before the AI has answered. On a self-hosted or personal AI connection that's slow (100s+ per call), the web-search identify was timing out at 20 seconds and reporting "nothing found": even though the AI was still working and would have identified the item. The timeout is now generous enough (matching the matchmaker) for a slow model to finish, so far fewer scans fall through to "fill in manually" just because the AI was slow.
