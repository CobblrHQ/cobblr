---
type: internal
scope: ci
date: 2026-09-17
---
**A contended CI box is INCONCLUSIVE, and the retry it earns now runs.** The test job's verdict reads the box's load beside the database's queue, retries timeout-shaped failures once the box is quiet, names an assertion that followed a timed-out attempt as the retry's leftover rather than a finding, and scales vitest's timeouts by the load at start. The retry step itself had died on its own exit code under `bash -e` every time it was needed; a lint now refuses that shape in every workflow.
