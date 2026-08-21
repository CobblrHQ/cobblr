---
type: feature
scope: platform
date: 2026-08-21
docs_target: SELF_HOSTING.md#Where your users go with a question
---
**The feedback box can point at every place you run, not just Discord.** It offered one community link, hardcoded to a chat invite; a forum or a docs site had nowhere to go. An instance now lists whichever it has - Discord, a community forum, an issue tracker, documentation - each with a line saying what you would go there for, in the order that answers a question fastest. They appear in the feedback box and the account menu. Set none and no links show.

## docs

Set any of these on your instance and they appear in the **Feedback** box and the account menu. Set none and neither shows a link.

| Variable | Shown as | For |
|---|---|---|
| `COBBLR_DISCORD_INVITE_URL` | Discord | Same-day questions. The older `DISCORD_INVITE_URL` still works. |
| `COBBLR_FORUM_URL` | Community forum | Longer questions, and answers that stay findable. |
| `COBBLR_ISSUES_URL` | Issue tracker | Your own tracker, if you run a fork. |
| `COBBLR_DOCS_URL` | Documentation | Where a feature is explained. |

They are offered chat first, then forum, then tracker, then docs: chat gets the fastest answer, and filing an issue is work most questions do not need. Each must be an `http(s)` URL; anything else is ignored rather than shown. An empty value counts as unset.

The **"Open an issue"** button on a self-hosted instance is separate: it carries the report you just typed and goes to Cobblr's own tracker, because that is where a bug in Cobblr belongs.
