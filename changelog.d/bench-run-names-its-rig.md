---
type: internal
scope: ci
date: 2026-09-17
---
**A bench run says which build it measured.** The rig's build sha is read before the run, printed, written into the run record and carried on every `bench / corpus` status; a verdict measured on a rig that lacks the commit's bench-relevant changes is a warning naming both shas, never a verdict. `scripts/bench-rig-refresh.sh` pulls the rig under its lock and believes the api's own healthz, not the pull.
