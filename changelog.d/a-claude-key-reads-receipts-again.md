---
type: fix
scope: core-ai
date: 2026-10-10
---
**A workspace whose AI is a Claude key reads receipts again.** Reading an emailed or uploaded receipt, planning where things go and naming a scan session sent their instructions in a form Claude's API refuses, so each one failed with "the AI errored". They now reach Claude the way it takes them.
