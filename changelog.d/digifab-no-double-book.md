---
type: fix
scope: digifab
date: 2026-08-08
---
**A queued print can no longer be dispatched onto a printer that is already busy.** When two assignment passes overlapped (creating a job kicks one off, and there is a regular re-tick), each could read the same printer as free and hand it a different job, which in the real world means a plate landing on an occupied bed. Freeness is now checked by the database at the moment the job is claimed rather than from a snapshot taken earlier in the pass, so the second pass simply finds nothing to claim and the job waits its turn.
