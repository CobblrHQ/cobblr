---
type: fix
date: 2026-09-10
---
When a change moves the AI rail, its benchmark is deferred to the nightly run. That deferral is now reported as a warning rather than an error, so the commit no longer reads as a failed build for something that was never measured. Releases are unaffected: a deferral still counts as no verdict and the previous one stands.
