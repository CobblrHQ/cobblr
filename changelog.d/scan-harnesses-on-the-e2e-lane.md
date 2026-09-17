---
type: internal
scope: ci
date: 2026-09-17
---
**The rendered scan-inbox harnesses run nightly on the e2e lane.** Desktop and phone layout checks for the scan inbox provision their own workspace on the stack under test and run without anyone remembering them; a real failure ships the digest. Never on the deploy gate.
