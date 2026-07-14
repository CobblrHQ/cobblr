---
type: fix
scope: core-scan
date: 2026-07-14
---
Three fixes to the phone scanner. The **Filing into…** confirmation now shows at the top of the frame instead of at the bottom, where it sat directly on top of the capture button and blocked it. Holding the camera on the **same QR code no longer spams a new toast every couple of seconds**: a code held steady in the frame is now treated as one scan, and only scans again once you move it out of view and back. And the **live preview no longer stutters when a location QR is read**. Reading a bin or location label sets a filing target and makes no inbox item, so it no longer grabs a full-resolution photo it would only throw away.
