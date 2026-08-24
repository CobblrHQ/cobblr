---
type: internal
scope: release
date: 2026-08-24
docs_target: none (documented directly in docs/operations/SELF_HOST_RELEASE.md, "Telling the changelog which nightly became the release")
---
Cutting a release now stamps the forum's copy of the nightly as well as Discord's, so both surfaces say which release a nightly became. Two Discourse traps are handled in code rather than in a runbook: the recorded `forum_url` carries a post NUMBER (`/t/22/11`), not the post id the edit endpoint wants, so treating one as the other would edit a different post successfully; and under the narrow `changelog-editor` key almost every read is refused, so resolving the id and reading the markdown are a single `GET /t/<topic>/posts.json?include_raw=true`. The key is disabled by default, so a 403 now says that instead of looking like a header problem. Best-effort throughout: a release never fails because a forum key is switched off.
