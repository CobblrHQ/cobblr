---
type: improvement
scope: permissions
date: 2026-07-18
---
**Permissions is a grid you can actually read.** It used to be one row per member and one column per capability, which ran off the side of the screen with six-line column headers, and it listed every action every module registers, including the wire-only ones an automation fires (an OBD dongle updating your mileage was offered as a human permission). Now capabilities are rows grouped by the module that owns them, collapsed until a group has something configured, and the columns are the holders: owners and admins as one implicit column, then each custom role, then each remaining member. A person's cell tells you where their access comes from, granted here, inherited from a named role, or implicit, so one screen finally answers "what can this person do". Editing a role column changes it for everyone who holds that role. If everyone in the workspace is an owner or admin, the whole grid collapses to a single sentence, because there is nothing to configure.
