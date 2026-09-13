---
type: improvement
scope: bundles
date: 2026-09-13
---
**Install a bundle by its id, and hear why when that is not possible.** `POST /bundles/install` now takes a bundle's `id` as well as its manifest: the deployment's own catalog answers first, then the configured registry. An id nothing knows says so in a sentence (no registry configured, send the manifest; or not found in the registry named), instead of a bad-request error about a missing field, and the health check reports whether a registry is configured and how many bundles the build carries.
