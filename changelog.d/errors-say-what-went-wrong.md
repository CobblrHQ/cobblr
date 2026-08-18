---
type: fix
date: 2026-08-18
---

When something fails behind the scenes, Cobblr now tells you what happened
instead of showing a bare "Non-JSON response (502)". That message described the
plumbing rather than the problem, and it hid the real explanation the server had
already sent. Errors from a gateway, a relay or an AI connection now carry the
actual reason, and a failed Ask Cobb turn is recorded in the server log so it can
be looked up rather than reconstructed.
