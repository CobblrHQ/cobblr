---
type: feature
scope: ai
date: 2026-10-28
docs_target: docs/modules/core-ai.md#A live answer counts every record and keeps the name as typed (#7816, #7817)
---

With no AI connected, Ask Cobb answers what's due this week from the calendar, says where a thing is, and adds stock to a part by name as a card to confirm

## docs

**Answers from the workspace, sent or typed.** With no AI connected, a question the workspace can answer gets that answer whether it is still being typed or has been sent: how many of a kind, what is low, what needs you, where a thing is (named with its place, "Table saw · in Garage"), and what is due today, this week or in the next 30 days, read from the calendar every module feeds. One function, `workspaceAnswer`, serves `/basics/peek` and `/basics/answer`, so the reply never says a question needs AI after the box answered it (#8864, #8865, #8867).

**Adding stock by name.** "add 10 zip ties to the garage shelf" is a computed command (`add-stock`, `modules/core-ai/src/stock-change.ts`): it reads the number, the thing and the place, finds the one part every word names, and offers "Add 10 to Zip ties 200mm (40 → 50, Garage shelf)" as a card to confirm and undo, run through `inventory:adjust-stock`. Two parts that fit get a question naming each with its place; none is said so. Nothing runs on a guess (#8868).
