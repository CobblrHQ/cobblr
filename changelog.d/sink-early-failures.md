---
type: internal
scope: ci
date: 2026-08-17
---
CI job logs now reach the durable sink even when a job fails before the step
that writes its output, so an early failure is diagnosable instead of leaving
nothing anywhere, and lint:ci-sink now checks for it.
