---
type: fix
date: 2026-10-07
---
**A USB or Bluetooth scanner can read a component reel's label.** Digi-Key and Mouser reel labels carry separator characters that a keyboard-mode scanner sends as Ctrl key presses, and the scan was thrown away at the first one. A scanner now reads them the same way the camera does, and a Ctrl shortcut you press yourself still works as before.
