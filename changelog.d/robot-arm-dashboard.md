---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-19
---

Universal Robots, Elite and Dobot arms connect through the shop's bridge: their programs are listed, loaded, started, paused and stopped, and their state and faults watched.

## docs

Bridge setup offers **Robot arm: Universal Robots e-Series**, **Universal Robots CB3 (no remote mode)**, **Elite CS** and **Dobot CR / Nova**. Give the controller's address and, optionally, the folder of its programs on the bridge, then set the machine up as a robot arm. Its programs are read from that folder with each file's checksum as its revision, and a Universal Robots arm also takes a URScript program sent from the app. Load, start, pause, resume and stop go through the arm's own dashboard; brake release, clearing a stop and every motion stay at the pendant. Tested against a simulator; checking on a real arm is still to come.
