---
type: feature
scope: core-ai
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
docs_published: 2026-08-07
---
**Cobb gets an autopilot, because every change he makes is now tracked and undoable.** The "Propose changes" toggle grows into a three-way mode, Claude-Code style: **Ask** (every change needs your Confirm; the default), **Auto** (record creates, edits, and deletes apply immediately), and **Off**. Auto is safe to hand him because of the new **AI change ledger**: every write Cobb performs, confirmed or automatic, is recorded with a full before-image, and gets an **↩ Undo** button right in the chat. Undo a create and it's deleted; undo an edit and the old values come back; undo a delete and the record is recreated. Actions (print a label, adjust stock) still always ask; they can't be un-done in the real world. And the classic record kinds (parts, machines, assets, projects, tasks, lists) are now fully editable/deletable through Cobb too, not just createable.

## docs

Ask Cobb's write control is a three-way mode (click the chip to cycle), per-person per-workspace:

- **Changes: ask** (default): every create/update/delete/action Cobb wants to make arrives as a card you Confirm or Cancel.
- **Changes: auto**: record creates, field updates, and deletions **apply immediately**, and Cobb can chain them ("file these three ideas as notes" happens in one turn). Safe because of the ledger below. **Actions still ask**: printing a label or adjusting stock has real-world side effects with no undo.
- **Changes: off**: Cobb explains what he *would* do, and points you at the chip.

**The AI change ledger.** Every write Cobb executes, whether you confirmed it or auto mode applied it, is recorded with a full before-image. Each one shows an **↩ Undo** in the chat: undoing a create deletes the record; undoing an update restores exactly the fields that changed; undoing a delete recreates the record from its image (as a new record, which Cobb says plainly). An undo is itself ledgered, so you can undo an undo. `GET …/modules/core-ai/chat/writes` lists the full history with honest per-row undoable flags.

Parts, machines, assets, projects, tasks, and lists join knowledge entries and tracking metrics as fully creatable/editable/deletable through Cobb (their modules now declare all three routes), which is also what makes their changes undoable.
