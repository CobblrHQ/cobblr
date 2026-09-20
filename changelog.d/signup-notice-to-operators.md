---
type: selfhost
scope: platform
date: 2026-09-20
docs_target: none (documented directly in docs/USER_GUIDE.md, Notifications - Channels)
---
Your instance can now tell you when somebody signs up. `platform.account.created` fires for every new account, whichever door it came through (open signup, an invite, a managed-app signup, a sign-in link, a central identity, an admin adding a user), and is delivered to the addresses in `SUPERADMIN_EMAILS`. By default it lands in each admin's in-app inbox (the bell); to have it reach Discord, one step, once: sign in as an admin, open Me - Notification channels, and bind `platform.account.created` to your Discord webhook. A try sandbox speaks on its own events instead, `platform.sandbox.started` when a visitor begins one and `platform.sandbox.kept` when they keep it, so a busy booth cannot drown the real signups; bind those the same way if you want them. Nothing is sent if you have not set `SUPERADMIN_EMAILS`.
