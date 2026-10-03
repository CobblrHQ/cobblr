---
type: feature
scope: platform
date: 2026-10-03
docs_target: docs/USER_GUIDE.md#4. The platform layer
---
Deleted records can now be restored with their original details and contents from Recently deleted for 30 days.

## docs

Open Configuration, then Recently deleted under System, to see records deleted
in the last 30 days. Each entry shows its name, source collection, who deleted
it and how much time remains. A collection's Recently deleted link opens just
that collection's entries; Show all deleted records returns to the full list.

Restore brings a record back with its original id, custom fields, tags,
placements, links, attachments and any saved child records. It leaves later
changes to other records alone. You can also use Undo immediately after a
delete. Deletes made through Cobb, the API and bulk actions use the same store.

Delete forever removes a record from recovery immediately. Workspace owners
and admins can permanently remove any entry; other members can permanently
remove only records they deleted. Otherwise recovery ends after 30 days.
Deleted files keep their existing quota checks and file removal rules.
