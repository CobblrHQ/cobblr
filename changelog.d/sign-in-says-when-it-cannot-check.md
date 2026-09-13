---
type: fix
scope: auth
date: 2026-09-13
---
**Sign-in says so when it cannot check what this deployment allows.** When the server's sign-in settings could not be fetched, the sign-in and app start pages assumed signing up was open and drew the form, which on an invite-only deployment refused you after you had typed everything. Both now say they could not check and offer to try again.
