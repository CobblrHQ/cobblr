---
type: internal
scope: release
date: 2026-09-01
---
The daily release now also publishes the hosted overlay as `cobblr-cloud-api:nightly`, rebuilt on the commit it just cut, so a hosted instance can track the same build the nightly channel carries instead of `latest`, which moves on every core build. Self-hosters are unaffected: the overlay is not part of the open-core distribution.
