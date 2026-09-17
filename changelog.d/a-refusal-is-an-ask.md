---
type: feature
scope: platform
date: 2026-09-17
docs_target: docs/USER_GUIDE.md#Approval requests
---
**A refusal now explains what is missing and lets you ask for it.** When something you try needs a permission you do not hold, or a bundle only an owner or admin can install, Cobblr says so in words (not an internal identifier), names who can decide, and offers Ask. The owners and admins get a card with Approve and Deny in the app and, if they have Discord notifications on, as a Discord message; a yes gives exactly what was asked to exactly you, the answer reaches you as a notification, and Finish reopens what you were doing and completes it once. A no tells you why. What cannot be asked for (a read-only role, an owner-only act) is said plainly instead of pretending. Approving never changes anyone's role.

## docs

The refusal you see names what is missing (for example, "This needs permission to create parts in Inventory"), who can give it, and whether a request is already waiting. **Ask** sends one request; asking again from another screen finds the same one. Owners and admins answer from the card, from the bell, from a Discord DM, or from **Configuration → Permissions → Requests**, which lists everything waiting. A yes applies the one thing asked for (a single capability for you, or the bundle installed for the workspace) and tells you; **Finish** on that notification replays what you were doing, once, after checking the yes still holds. A no tells you why, if the person said. A request nobody answers expires after a week; ask again.

What cannot be asked for is said plainly: a read-only guest is told their role has to change, and things only the workspace owner may do stay with the owner. Approving never changes anyone's role, and a request can never ask for the power to approve.
