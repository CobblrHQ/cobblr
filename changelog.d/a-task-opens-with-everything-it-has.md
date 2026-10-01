---
type: feature
scope: projects
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.3 Projects
docs_published: 2026-10-01
---
**Open a task to see and set everything about it.** Click a task on its project and it opens with its status, due date, priority, size, details, custom fields, tags and discussion, all editable there. Set what it waits on by picking another task, and see which of those are still holding it up. A task past its due date shows as late on the project. Links to a task from search or Ask Cobb now open that task instead of the project list, and deleting a task asks first.

## docs

**A task, whole.** Click a task's name on its project to open it:

- **Status**: to do, doing, done, on hold or cancelled.
- **Due**, **Priority** and **Size**. A task past its due date shows **late** in red on the project; a high or urgent one says so.
- **Details**, custom fields, tags and a discussion.
- **Waits on**: what the task is waiting for, marked *waiting* or *clear*. Pick another task from the same project to add one; the cross removes it. A task can't wait on itself or on a task that already waits on it. Once everything it waits on is done or cancelled, the task is free.
- **Delete task** asks before it deletes.

Every task has its own address, `/projects/tasks/<id>`. A search result or Ask Cobb takes you straight to the task, open on its project.
