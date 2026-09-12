---
type: selfhost
scope: auth
date: 2026-09-12
---
If you run the signup captcha, you can now let one designated automated reviewer through it without turning the captcha off for everyone: set `COBBLR_CAPTCHA_REVIEW_TOKEN` and have that reviewer send the value in the `x-cobblr-captcha-review` header. It skips only the captcha check, for only that request, and every use is logged. Unset, nothing changes.
