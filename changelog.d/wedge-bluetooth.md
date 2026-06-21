---
type: fix
scope: scan
date: 2026-06-21
---
Hands-free barcode scanning now works with **Bluetooth** scanners. On the Scan Inbox page a HID scanner types the code "behind the scenes" and auto-ingests it — but the detector judged a scan by the gap between individual keystrokes, which is too strict for Bluetooth's jitter (USB dongles are steadier), so BT scans were silently dropped unless you first opened the UPC field. It now judges the **whole code's average speed** instead — tolerant of Bluetooth's variable timing, still ignores human typing — so hands-free scanning works the same whether your scanner is USB or Bluetooth.
