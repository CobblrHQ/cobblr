---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-20
---

Robot arm programs are versioned and compared before release, copies to another arm are a re-teach checklist, and backups are proven by a restore test.

## docs

**Changed arm programs and backups.** Each revision of an arm's program keeps its text, so **Review changes** shows, line by line, what changed since the revision last released on that arm. A new revision, whether edited at the pendant, copied or restored, does not run until an admin chooses **Release this revision**; a run still needs its approval at the cell. **Copy to another arm** opens a re-teach checklist on that arm (tool and payload, waypoints, I/O, one watched run at reduced speed, the risk assessment), and ticking the last check releases the copy there. **Back up now** keeps every program and the installation they depend on; set a schedule and how many to keep. A backup is proven only by **Test restore there** on a spare arm or a simulator, which reads the programs back and says whether every one returned at its revision. Restoring an arm's own programs is done at its station with the arm stopped, and writes programs only: the installation, with its safety settings, is restored at the pendant.
