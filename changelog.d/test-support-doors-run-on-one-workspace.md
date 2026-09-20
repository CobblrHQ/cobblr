---
type: internal
scope: ci
date: 2026-09-20
---
A test-support migration door now runs its boot pass on the calling test's workspace only, so a pass that relabels or moves rows cannot reach another test's workspace mid-flight; a lint holds every such door and every test that presses one to that.
