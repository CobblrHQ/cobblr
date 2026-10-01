---
type: feature
scope: workspaces
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#Multiple workspaces
docs_published: 2026-10-01
---
An owner can delete a workspace from its General settings. It goes after a two-week grace period, everyone in it sees the date, any owner can keep it until then, and a full backup taken just before it goes stays downloadable from each owner's account for 30 days.

## docs

**Deleting a workspace.** An owner deletes a workspace from **Configuration → General → Delete this workspace**, by typing its name. It is not deleted at once: it is set to be deleted in 14 days, and until then it works as usual. Everyone in it sees a strip at the foot of every page with the date, and an owner sees **Keep this workspace** there and on the settings page, which cancels it. On the day, the workspace and everything in it (records, photos, files, history) are removed for everyone. Just before it goes, a full backup is taken; if that backup fails, the workspace is not deleted and it is tried again later. Every owner can download that backup from **Your account → Backups of deleted workspaces** for 30 days, and restore it into any workspace from its Backup page. Its photos and files are removed from the server along with it. You can also download a backup yourself at any time (**Configuration → Backup & blueprints**). Only an owner can delete or keep a workspace; an admin cannot. A self-hosted instance can change the grace period with `COBBLR_WORKSPACE_DELETE_GRACE_DAYS` and how long the backup is kept with `COBBLR_WORKSPACE_FINAL_EXPORT_DAYS`.
