---
type: feature
scope: builds
date: 2026-10-27
docs_target: docs/user-guide/builds.md#3.25 Builds (light bill-of-materials)
docs_published: 2026-10-28
---
A scrapped print keeps the filament it melted spent, and each part of a build can be marked to come back to stock instead.

## docs

**What a scrapped print gives back.** A print melts its filament whatever the verdict, so when a printed build is scrapped what it used stays used. Each part line on the build page says what happens to it: **Used up** (the default, right for filament and anything the machine consumed) or **Back to stock** (right for inserts or a kit that a failed print never fitted). A print stopped partway gives back the share it never reached, and one cancelled before it started gives back everything. When the print job names its spool, the spool is charged once, by what the print measured, and the build's line for that spool is not charged again.
