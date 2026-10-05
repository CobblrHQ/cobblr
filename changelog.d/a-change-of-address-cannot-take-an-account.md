---
type: security
scope: account
date: 2026-10-05
---
Changing the address you sign in with can no longer be turned against you. Taking the account back from the old address now stops the old password working, signs out every device, and cuts off every API token and connected app, then asks you for a new password straight away; before, whoever made the change could sign back in with the password they already knew. Reset and sign-in links sent to the old address stop working once the address changes, an API token cannot start a change, and asking is limited to a few times an hour. Links in every email Cobblr sends (sign in, reset, verify, invites) now always point at this site's own address, never at whatever address the request that sent them named. An account without a password can now change its address too, right after signing in.
