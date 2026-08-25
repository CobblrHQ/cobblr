---
type: fix
scope: purchases
date: 2026-08-25
---
Orders created from a receipt now join the arrival watch: a future promised date keeps the order open instead of filing it as already arrived, the tracking number you add on the scan row reaches the order itself, and the receipt's promised date becomes the order's own estimate with its calendar event. Arrival questions land in your chosen digest window, are never repeated because of a crash, and marking something arrived in the evening records the right day. Changing a tracking number starts a fresh watch, and a number no carrier recognises says so instead of reading "Not checked yet" forever.
