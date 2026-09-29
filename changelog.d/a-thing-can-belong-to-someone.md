---
type: feature
scope: fields
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#Saying what a field means
---
**Say whose a thing is, even if they are not a member.** A new **person** field type, with the meaning **Who it belongs to**, picks from the workspace's People: every member, plus anyone you add by name (family, a friend whose things you keep). Configuration → People lists them, and an admin can invite someone on the list to join; when they accept, everything that was theirs stays theirs. **My things** (in your account menu) lists what is yours across every collection, and each person on the People list has the same page; a saved view grouped by Owner makes a column per person; a label template's `{{owner}}` prints the name; and the assistant answers "what does Alex own". Removing a member who owns things asks who gets them, and someone who already left can have theirs handed on from the People list. Names stay in the workspace.

## docs

**Say whose a thing is.** Add a field of type **person** with the meaning **Who it belongs to**.
Its dropdown lists every member, then anyone added by name; **+ Someone else…** adds a name on
the spot. **Configuration → People** holds the list: add or rename people, and (as an admin)
press **Invite to join**. When they accept, every item that was theirs is still theirs. A member
who leaves keeps their name on their things, marked *(left)*; removing a member who owns things
asks who gets them, and **Hand on their things** on the People list passes on what someone who
already left kept. **My things** in the account menu
lists what is yours across every collection; press a name on the People list for theirs. Group a
saved view by Owner for a column per person, put `{{owner}}` in a label template to print the name,
or ask the assistant "what does Alex own". Names never leave the workspace.
