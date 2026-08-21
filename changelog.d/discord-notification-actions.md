---
type: feature
scope: platform
date: 2026-08-21
docs_target: docs/USER_GUIDE.md#Notifications
---
A notification can now carry the action that resolves it, so a Discord message about a delivered parcel comes with a button to say you have it.

## docs

### Acting on a notification where you read it

Some notifications now carry the thing you would do about them. A message
saying your parcel was delivered comes with **Got it, filed away**. Pressing it
records the arrival without opening Cobblr.

This works wherever the channel can show it. On Discord that is a button on the
message. Channels that cannot show buttons deliver the same message with its
link, so nothing is lost by reading your notifications somewhere plainer, and no
message depends on a button to make sense.

Discord messages reach you only if you have connected Discord under your
profile **and** subscribed that kind of notification to it. Connecting alone is
not enough; without a subscription, notifications go to the in-app bell only.
