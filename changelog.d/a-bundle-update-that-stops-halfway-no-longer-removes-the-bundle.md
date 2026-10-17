---
type: fix
scope: bundles
date: 2026-10-17
---

A bundle update that stopped or failed part-way used to leave the workspace without the bundle, and the hourly update pass never found it again. The old version now stays until its replacement is in, and an install that did not finish is finished on the next pass, with no reinstall.
