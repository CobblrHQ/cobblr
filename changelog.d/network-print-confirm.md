---
type: improvement
scope: labels
date: 2026-07-22
---
Sending labels to a network printer no longer just fires and forgets. It keeps them in the queue and drops a to-the-side prompt, "Mark printed once it looks right?", so a jam or a wrong size doesn't burn the batch. Click Mark batch printed once the output is good and those labels clear; if the send fails, the prompt offers Reprint. Bluetooth printing is unchanged (it already knows the result the moment the labels are out).
