---
type: feature
scope: core-locations
date: 2026-09-30
docs_target: docs/USER_GUIDE.md#3.12 Locations (foundational)
---
Deleting a place can be undone. The message after a delete has an Undo that puts back the place, every place that went with it, and each thing where it was, and Cobb's undo does the same. The delete dialog now says how many places and how many things go with it. Deleting a room or rack with places inside it is an owner's or admin's call: a member can still delete an empty shelf, and can ask for the rest.

## docs

**Undo a delete.** Deleting a place takes every place inside it too, and the
things kept in them are left with no place set. Before you confirm, the dialog
says how many of each will go. After the delete, press **Undo** in the message:
the place and every place that went with it come back as they were, and each
thing goes back where it was. Anything someone has moved somewhere else in the
meantime stays where they put it, and the message tells you how many. Undoing
a delete Cobb made works the same way.

**Who can delete a room.** Anyone who can edit places can delete one with
nothing inside it. Deleting a place that has places inside it, a room or a
rack, needs an owner or admin, or the **Delete a place with places inside it**
permission, which an admin can give on the Members page. If you do not have it,
Cobblr tells you and offers to ask; once someone says yes, you can finish the
delete from the notification.
