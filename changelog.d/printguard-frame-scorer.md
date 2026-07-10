---
type: feature
scope: digifab
date: 2026-07-07
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
---
New **"PrintGuard (send frames)"** detector option: Cobblr grabs a frame and posts it to PrintGuard for a verdict, instead of PrintGuard pulling the camera itself. This is the path for **cloud Cobblr + a LAN camera** (or any setup where PrintGuard can't reach the camera but Cobblr can). It uses PrintGuard's new `/classify` endpoint, which ships in PrintGuard 2.3.0, and **Test** now reads the running version and tells you clearly if the box is too old ("needs PrintGuard ≥ 2.3.0, found 2.2.2") instead of silently doing nothing.

## docs

PrintGuard offers a second mode in the detector picker: **"PrintGuard (send frames)"**. Instead of PrintGuard pulling your camera, Cobblr grabs a frame and hands it to PrintGuard to score. Pick it when PrintGuard *can't* reach the camera but Cobblr can, typically cloud Cobblr with a LAN camera. It needs PrintGuard **2.3.0 or newer**; the **Test** button reads the running version and tells you plainly if the box is too old ("needs PrintGuard ≥ 2.3.0, found 2.2.2").
