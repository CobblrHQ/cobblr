---
type: feature
scope: platform
date: 2026-08-26
docs_target: none (documented directly in docs/USER_GUIDE.md 3.22½ "Running a public demo instance")
---
**A public demo can hand visitors its login instead of making them find it.** Set `COBBLR_DEMO_SIGNIN_EMAIL` and `COBBLR_DEMO_SIGNIN_PASSWORD` and the sign-in page shows that shared login and pre-fills both fields, so the first thing someone does is press one button. `COBBLR_DEMO_SIGNIN_NOTE` adds a line of your own underneath ("Everything here resets every 15 minutes."). Both credentials are required or nothing is published, and it never overwrites something a visitor has already typed.
