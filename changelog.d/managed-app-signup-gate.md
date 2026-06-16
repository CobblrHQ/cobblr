---
type: feature
scope: platform
---
**Managed-app signup funnel gate**: a `/start/yarn`-style consumer signup can now be opened on a deployment *without* opening generic platform signup. The new `COBBLR_MANAGED_APP_SIGNUP_ENABLED` flag (default off in production) exempts managed-app signups — and only those, which land in a locked single-app workspace — from the invite-only gate. Set it on staging to test the whole "Cobblr for Yarn" funnel end to end; production stays closed until it's deliberately flipped there.
