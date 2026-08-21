---
type: feature
scope: platform
date: 2026-08-21
docs_target: docs/USER_GUIDE.md#Notifications
---
Pressing a button on a Cobblr notification in Discord now does the thing, without opening Cobblr.

## docs

### Answering a notification from Discord

When a notification offers an action, pressing it in Discord carries it out and
the message updates to say so. The buttons disappear once used, so an old
message in your history cannot be pressed a second time.

Cobblr checks that the press came from Discord itself, and that the person
pressing is the person the notification was sent to. A button from someone
else's notification does nothing.

If something goes wrong, the message says so and the link in it still takes you
to the right place.
