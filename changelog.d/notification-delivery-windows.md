---
type: feature
scope: notifications
date: 2026-08-21
docs_target: docs/USER_GUIDE.md#4.7 Notifications
---
**You can now say when a channel is allowed to interrupt you, instead of hearing about everything the moment it happens.** Set a delivery window on a channel and anything routine waits and arrives together, once, as a single message. Anything urgent still comes straight through, so choosing a quiet channel never means missing something that mattered. In-app notifications are unaffected and always immediate.

## docs

### Notification delivery windows

By default every channel tells you about things as they happen. That is right for a bell you glance at and wrong for a channel that pushes into your attention, especially once you are tracking enough things to hear from several of them a day.

You set these under **Notifications, Delivery**, per channel. They are yours rather than a workspace's, so one daily message covers every workspace you are in.

A **delivery window** lets you set, per channel, when messages are allowed to arrive:

| Setting | What happens |
|---|---|
| **Immediate** | Every notification arrives as it happens. This is the default for email and the in-app bell. |
| **Daily** | Routine notifications wait and arrive together as one message, at a time you choose, in your own timezone. |

Two things stay true whatever you pick:

- **Urgent things still interrupt.** A window only holds routine notifications. Anything a module marks as high or urgent, like a delivery that needs putting away now, comes straight through. Choosing a daily window never means missing something time-sensitive.
- **The bell is never delayed.** In-app notifications and your notification history are unaffected. A window changes when a channel *pushes* to you, not what your workspace records.

If several things happen before your window opens, you get one message listing them rather than one message each. A quiet day sends nothing at all, so an empty digest never arrives just to tell you nothing happened.

Each channel actually carries **two** of these, one for conversation and one for things a date brought up, so chat can reach you live while everything due today waits for the morning. See "When things arrive" below.
