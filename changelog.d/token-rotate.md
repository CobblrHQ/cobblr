---
type: feature
scope: admin
date: 2026-08-06
docs_target: docs/USER_GUIDE.md#4.7 Notifications
---

Rotate a token from its row: the dialog reopens prefilled with the same name and
scopes, you adjust what you need, and mint a fresh value. The old token keeps
working until you revoke it, so the daemon using it does not go down mid-swap.

## docs

An existing token's scopes can never be edited. Its value is already sitting in
some daemon's environment, so changing what it reaches would change the reach of
a credential someone already holds, and the record of what that token could do
would stop being true.

Rotate instead. The rotate button on a token row reopens the mint dialog
prefilled with that token's name and scopes; adjust either, then mint. You get a
new value shown once, and the old token stays live so you can paste the new one
wherever it is used before revoking the old. The reveal screen offers that
revoke directly once you are done.
