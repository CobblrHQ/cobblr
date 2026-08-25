---
type: improvement
date: 2026-08-25
---

Parcel notifications now go to the parcel's owner instead of the whole workspace. The owner is figured out automatically: whoever added the tracking number, or failing that whoever captured the receipt. Everyone else in the workspace is no longer pinged about orders that are not theirs. If the owner has since left the workspace, the notification falls back to all members so a waiting parcel is never silently dropped.
