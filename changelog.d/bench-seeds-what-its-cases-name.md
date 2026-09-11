---
type: fix
date: 2026-09-11
---
Three benchmark cases about moving records between lists had failed every night since they were written, because the workspace they are measured against contained neither the records nor the list they name. The benchmark now creates both, and refuses to run at all if that workspace has grown a list nobody expected, which is what quietly turned a leftover test list into what looked like a regression.
