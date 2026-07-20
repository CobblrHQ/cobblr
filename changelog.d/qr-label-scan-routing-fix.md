---
type: fix
date: 2026-07-20
---

Scanning a Cobblr label works again. Labels printed since 11 July encoded a shorter code than four of the scanning screens were looking for, so the camera, a USB or Bluetooth scanner, the Scan page and Live Sort all quietly failed to open what you scanned and filed it as an unrecognised item instead. Labels printed before that date kept working, which made it look like the feature had only broken for new labels. All four now read labels through one shared piece of code, so they cannot drift apart again.
