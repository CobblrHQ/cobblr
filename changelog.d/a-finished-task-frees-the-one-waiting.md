---
type: fix
scope: projects
date: 2026-09-29
---
**Finishing a task frees the one waiting on it.** A task set to wait on another task stayed blocked after that task was done. Now it counts as free as soon as the task it waits on is done or cancelled, and waits again if that task is reopened. A task can no longer be set to wait on itself or on a task that is already waiting on it.
