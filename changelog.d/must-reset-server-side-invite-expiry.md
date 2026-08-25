---
type: fix
scope: platform
date: 2026-08-25
---
A required password reset is now enforced by the server, not just the app: until you set your own password, workspace changes are refused (reading still works, and the reset page itself is unaffected). Signup invites minted without an explicit expiry now default to 14 days instead of living forever, and requesting a new password-reset link invalidates any older unused links so only the newest one works.
