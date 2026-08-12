---
type: fix
scope: scan
date: 2026-08-12
---
Pasting a product link into the scan box adds it again. It had been rejected
before it reached the code that handles links, and the failure was reported as a
green "Added 0 URLs", so it looked like nothing had happened rather than like an
error.
