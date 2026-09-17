---
type: internal
scope: ci
date: 2026-09-17
---
**A test can hold a write in flight.** A fixture is settled by construction, so a defect that lives in when two writes land was invisible to the whole suite. The api under test now takes a hold on any outbound fetch (`/test-support/hold-outbound`, backed by the one fetch loop in `@cobblr/platform-net`), reports whether anything reached it, and answers from a canned response on release; `api/tests/in-flight.ts` is the helper, the picked-picture race is the first test built on it, and `scripts/detached-writes.mjs` lists where the detached writes are.
