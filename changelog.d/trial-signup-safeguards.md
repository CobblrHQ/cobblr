---
type: improvement
scope: onboarding
date: 2026-08-06
---
Signup gains opt-in anti-abuse controls, all off by default so nothing changes for an existing instance: a captcha on the signup form (Cloudflare Turnstile), a block on known disposable/throwaway email providers, and an option to require a verified email before an account can sign in. The trial tier also gains a humane reaper that emails an expiring workspace a heads-up, waits out a grace period, and never removes a workspace it could not warn first.
