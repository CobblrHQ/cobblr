---
type: feature
scope: auth
date: 2026-08-13
docs_target: docs/architecture/central-identity.md#What a surface does
---
Signing in with a Cobblr account on a surface that welcomes new people now gets you a workspace on the spot, instead of a dead end.

## docs
Signing in with your Cobblr account no longer stops at "no workspace here".

If you already have an account on that surface under the same address, signing in
centrally now finds it and links it, so you land in the workspace you already had
rather than an empty second one beside it.

If you are new and the surface takes new signups, it makes your workspace as you
arrive, exactly as signing up on the page would have.

Both need a confirmed email address on your Cobblr account. If yours is not
confirmed yet, it says so and points you at confirming it, because that
confirmation is what proves the address is yours before anything is handed over.
Surfaces that do not take new signups still say so plainly, and an account that
has been disabled stays disabled.
