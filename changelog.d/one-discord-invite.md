---
type: fix
scope: platform
date: 2026-09-22
---
**Every Discord link on an instance now points at the same server.** An operator who set both `COBBLR_DISCORD_INVITE_URL` and the older `DISCORD_INVITE_URL` got one server in the community list and another in the account chrome. The prefixed name wins everywhere now, as the self-hosting guide says.
