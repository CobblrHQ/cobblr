---
type: feature
scope: sharing
date: 2026-10-03
docs_target: docs/USER_GUIDE.md#4.5g Sharing (`/configuration/sharing`)
---
You can now share part of your workspace with someone, even when their account is on another Cobblr. **Settings, Sharing, Share with someone** makes an invite link; they accept it on their own Cobblr and get a workspace of their own for it, named after you. Each share shows when it last synced and what is waiting, keeps trying while the other side is offline, and either of you can end it.

## docs

**Sharing with someone.** In **Settings → Sharing**, **Share with someone** asks who it is for and makes an invite link. Send it to them. It works once, for a week.

They open it signed in to the Cobblr their account is on: this one, or another (the page asks for their Cobblr's address and takes them there). **Accept** makes a workspace for them called "*your name*'s workspace (shared)". They are its admin; you never have to go there, and it does not appear in your switcher.

Each share in Settings → Sharing shows who it is with, which Cobblr they are on, when it last synced and how many changes are waiting. When the other Cobblr cannot be reached, changes wait and are tried again on their own; **Sync now** tries at once. If their Cobblr is older than yours, the share says it needs updating instead of half-applying anything.

**End share** (yours) or **Leave** (theirs, in the shared workspace's Settings → Sharing) ends it on both sides: their shared workspace is removed, and your own things stay as they are. If the other side is offline, it hears as soon as it is back.
