---
type: fix
scope: core-ai
date: 2026-09-02
---
Connecting your own AI key and choosing which workspaces it serves now actually switches it on in a workspace that has no AI yet. Until now those workspaces were marked as allowed to use the key but never started using it, so a workspace could sit with no AI at all after you swapped providers, with nothing to say so: scans quietly fell back to the no-AI path and filed things into the wrong tables. Workspaces already in that state switch themselves on when the server next starts. A workspace that already has an AI keeps the one you picked, and an offer from somebody else still waits for you to accept it. And in Configuration, every connection that is approved but standing by now has a Use here button: the way to switch one on used to appear only when a workspace had two or more to choose between, so a workspace with exactly one idle connection had no control at all.
