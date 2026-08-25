---
type: fix
scope: platform
date: 2026-08-25
---
**A few small account-security tidies.** A guest, who is read-only, can no longer be handed a capability grant (change their role first if they should be able to act). An operator who has been removed as a platform admin stops being able to impersonate a workspace immediately, rather than for the life of an outstanding token. And the notifications module no longer describes browser push as if it were a finished channel.
