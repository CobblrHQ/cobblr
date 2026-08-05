---
type: fix
scope: scan
date: 2026-08-05
---
The auto-flash turns off when the room lights come on. Phone cameras adjust their exposure constantly, so a lit room and a flash-lit dark room look equally bright to the software, which is why the previous attempt kept the light on. It now watches the shape of the light instead: a flashlight makes a bright middle with dark edges, while room light is even, and that difference survives the camera's exposure adjustments. As a backstop the light also pauses briefly every 20 seconds to re-check the room with the flash out of the way, coming straight back if it is still dark.
