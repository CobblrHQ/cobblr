---
type: internal
scope: feedback
date: 2026-09-07
---
A team member's reply in a support thread is now filed on the ticket, marked as staff, without reopening or re-triaging it. `scripts/feedback-ticket.mjs` reads a whole ticket, its Discord thread and any linked PR in one command, so reviewing an autopilot PR against the ticket as it stands now costs one call instead of four.
