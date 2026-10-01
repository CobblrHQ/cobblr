---
type: feature
scope: core-tags
date: 2026-09-30
docs_target: docs/USER_GUIDE.md#3.6 Tags (foundational)
docs_published: 2026-10-01
---
Merging or deleting a tag can be undone, and the tag comes back on every record it was on. Because either one reaches every record carrying the tag, they now take an owner or admin; a member can still add, remove and rename tags, and can ask for the rest.

## docs

**Undo a tag merge or delete.** Deleting a tag takes it off every record that
carries it, and merging moves them all onto another tag. The message after
either has an **Undo** that brings the tag back, on every record it was on,
with any tags that were inside it. After a merge, the other tag keeps only what
it had before.

**Who can merge or delete.** Anyone can add a tag to a record, take it off, or
rename it. Merging or deleting a tag changes every record that carries it, so
it needs an owner or admin, or the **Delete a tag** or **Merge into another
tag** permission from the Members page. If you do not have it, Cobblr offers
to ask for you.
