---
type: fix
scope: platform
date: 2026-09-22
---
**The public repository can build its own api image again.** Its Dockerfile copies the demo seeds that a trial workspace is stocked from, and those seeds were not among the files published, so `docker build` stopped at that step for anyone building from the public source. The seeds are published now, and a check on every change proves that every file the published Dockerfiles ask for is a file that gets published, so this cannot come back quietly.
