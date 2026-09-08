---
type: feature
scope: assistant
date: 2026-09-08
docs_target: docs/design-decisions/ai-chat-tool-calling.md#There was no way to move a record between lists (2026-09-08)
---
You can now tell the assistant to move things from one list into another: "move all the tea from this page into the Tea section". It works out which records you mean and moves them, keeping their photos, their history and their printed labels. There was no way to do this before, which is why asking used to produce a second copy of everything or an offer to delete it.

## docs

Say which list you mean and it will do the rest: "move all the tea from this page into the Tea section", "put all my spices in the Spices list". Records keep their ids, so photos, history and any label you have already printed stay with them; only which list they are in changes.

Two things worth knowing. Say "section" or "list" when you mean one, because "put the drill in the garage bin" means a container and is handled differently. And it matches whole words, so asking for tea moves your Teas, Tea bags and Tea & Infusions, and leaves the steamer baskets where they are.

If your workspace has no AI connected this still works: it is worked out in code, and you see the exact list of what will move before anything does.
