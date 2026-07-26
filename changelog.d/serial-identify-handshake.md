---
type: fix
scope: labels
date: 2026-07-26
---
Fixed a serial printer being reported as "didn't identify itself" when it had actually answered, by waiting long enough for a Bluetooth link to wake and matching each reply to its question by content rather than by the order it arrived in.
