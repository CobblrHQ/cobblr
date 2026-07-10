---
type: feature
scope: digifab
date: 2026-06-18
---
**The print farm got a real cockpit: live camera feeds, temperatures, and pause/resume.** Each printer on the Fleet now shows its **live nozzle and bed temperature**, and you can give it a **camera URL** (your OctoPrint/Klipper webcam stream, or any MJPEG/HLS feed). Cobblr embeds the live feed right on the printer's card, so you can watch every machine from one screen. And a running print now has **Pause** and **Resume** controls (where the machine's manager supports it). Cobblr still never touches the camera or the hardware directly; it embeds the stream the manager already serves and asks the manager to pause; coordinate-not-control all the way down.
