---
type: improvement
scope: scan
date: 2026-08-05
---
Barcode scanning is about three times faster per attempt again. Reading codes at any angle had made every frame without a code in it do the maximum-effort work twice over, which cut the number of attempts per second on a phone by more than half. The routine sweep now runs lean and the expensive last-resort guess happens periodically instead of on every frame, with no loss in what gets read: all fifteen angle and clutter cases still decode.
