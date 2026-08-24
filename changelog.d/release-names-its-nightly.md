---
type: internal
scope: release
date: 2026-08-24
docs_target: none (documented directly in docs/operations/SELF_HOST_RELEASE.md, "Telling the changelog which nightly became the release")
---
Cutting a numbered release now says which nightly it was, immediately, on every changelog destination. A release is a blessed nightly re-tagged, so its contents were announced days earlier and a reader had no way to connect "2026.8.0" to the nightly they actually read about; the hand-written announcement closed that gap eventually, or in 2026.8.0's case not at all. `cut-release.sh` posts a short follow-up ("the nightly of <date> is now release <version>") and edits that nightly's own post to add a line saying so, which is what the publisher records message ids for. Best-effort, so a release never fails because Discord did, and idempotent through a `released_as` marker. Also fixed the reason editing a published post could never have worked: Discord rejects a request with no User-Agent, which POSTs got away with and a PATCH did not.
