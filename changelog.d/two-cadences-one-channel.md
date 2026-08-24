---
type: feature
scope: notifications
date: 2026-08-24
docs_target: docs/USER_GUIDE.md#When things arrive
---
Conversation can now reach you as it happens while everything due today waits for one message in the morning, on the same channel.

## docs

### When things arrive

Under Notifications, the Delivery tab now has "When things arrive": a cadence
per channel, set once for you rather than per workspace, so one daily message
covers all of them.

Each channel has two cadences, because the two kinds of message want different
rhythms:

- **Conversation** covers replies, mentions, and things that just happened.
  Most people want these as they happen.
- **Due today** covers things a date brought up: food expiring, a service
  interval reached, something running low. These usually read better as one
  list in the morning than as a dozen interruptions through the day.

So a common setup is Discord DM with conversation set to "as it happens" and due
today set to "once a day at 07:00". Chat still reaches you live, and the morning
message tells you the cucumbers expire today and the car is due a service.

"Due today" can also be left as "same as conversation", which is how delivery
worked before this existed.

Being mentioned by name always interrupts, whatever the cadences say.

The waiting count next to each cadence tells you what is queued, so you can see
what the next message will contain before it arrives.

### Email

Email carries a once-a-day message and nothing else. Cobblr will not mail you
per event: the volume that is fine as a glanceable DM is not fine in an inbox,
and a mailbox with forty notifications in it is a mailbox nobody reads.

So email starts arriving when you set one of its cadences to "once a day", and
that setting is the whole request. On "as it happens" it stays quiet, and the
screen says so rather than letting you configure something that never sends.

Turning email off under communication preferences still means off. A cadence
says when, never whether.
