---
type: fix
date: 2026-06-26
---
A barcode that resolves only to a generic category ("Whiskey", "Beverages" from Open Food Facts) now upgrades to the real product on re-run / "needs detail" — e.g. Maker's Mark Bourbon Whisky. The web identify already found it; an over-strict same-word check ("Whiskey" vs Maker's "Whisky") was discarding the correct answer.
