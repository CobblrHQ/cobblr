---
type: fix
date: 2026-06-24
---
Photo identification now works on workspaces whose AI is a personal connection. The detached "identify this photo" step ran with no caller, so it couldn't resolve the owner's connected AI and failed instantly with "no vision provider configured." It now routes through the user who triggered the scan/re-run, and a vision failure is logged instead of swallowed.
