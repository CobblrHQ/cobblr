---
type: fix
date: 2026-09-11
---
Pressing "Do it" on a move the workspace planned itself (moving the tea into the Tea list, say) now performs the move. It failed with a message about a missing record, because the action's name was lost between the plan and the write; a plan that runs an action and one that edits records now travel the same road.
