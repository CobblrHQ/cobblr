---
type: fix
scope: try
date: 2026-10-06
docs_target: none (no new control)
---
A sandbox that was being set up could occasionally fail to start when the cleanup of orphaned guest accounts ran at that exact moment; it now leaves new guests alone for ten minutes.
