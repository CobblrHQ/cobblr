---
type: improvement
scope: scan
date: 2026-06-21
---
Scanning the **same barcode again** no longer piles up duplicate rows in the Scan Inbox — it bumps the **quantity** on the existing pending entry (the way companion app does it), shown as a **×N** badge on the card. Scan a thing five times → one row, ×5. (Scoped per scan session + area, and only while the entry is still pending — a re-scan after you've filed it starts fresh.) Plus, a **phantom row with a spinner** now appears at the top of the inbox the instant you scan, so you know it registered while the few-second lookup runs, then swaps in for the real row.
