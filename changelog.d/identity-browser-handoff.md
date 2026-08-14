---
type: feature
scope: auth
date: 2026-08-13
docs_target: docs/architecture/central-identity.md#What a surface does
---
A Cobblr account can now sign you in to a surface directly, instead of that account only existing to be verified.

## docs
Signing in with a Cobblr account now works end to end. The account service sends
your browser back to the surface you were heading for, carrying a one-time code;
the surface trades that code for your identity behind the scenes and gives you a
normal session. The code is good once and expires in a minute, and your identity
token never travels in the address bar, so nothing reusable is left behind in
browser history or in a log along the way.

Nothing changes if you sign in with a password on a single instance: this is
additive, off unless a surface is configured for it, and local login keeps
working exactly as before.
