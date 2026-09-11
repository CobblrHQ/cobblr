---
type: feature
scope: ai
date: 2026-09-11
docs_target: docs/modules/core-ai.md#Actions say how they are undone, and where things went
---
Moving records into another list can now be undone from the chat, and the card after a move offers to open the list they went to. Under the hood an action can declare its own undo, and the card offers Undo exactly when one exists; whether an action needs confirming first is unchanged.

## docs
An action can register the action that puts it back (`registerUndo`, beside its handler and planner). When it runs, the way back is stored with the change, so Undo on the card runs it as a change of its own, which is itself undoable. A move between lists is the first: its inverse is the same move the other way. The card after a move also offers "Open <list>", the list page the records went to.
