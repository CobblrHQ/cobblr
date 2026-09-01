---
type: selfhost
scope: release
date: 2026-09-01
---
Nightly snapshot tags are named from the same day the release itself is named by, so the tag you pin matches the changelog post that describes it. They used to be read in UTC while the changelog read the local day, which meant an evening build took the next day's tag and the following morning's scheduled release was pushed to a `.1`. If you pin a dated nightly, tags already published keep their names; only new ones change.
