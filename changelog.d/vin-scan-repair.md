---
type: fix
scope: core-scan
date: 2026-07-14
---
Fixed: a barcode scanner that mangles a VIN label no longer sends you down a rabbit hole. A real scan of a door-jamb label came back with a stray leading character, which was enough for the VIN decoder to decline it, so the code fell through to the product-barcode lookup instead and came back as a completely unrelated product, name, photo and all. Two fixes, neither of which costs an AI call. A VIN is now repaired from a messy scan when the maths can prove the repair: the letters I, O and Q never appear in a real VIN, and every VIN carries a check digit, so a wrong reading is caught roughly ten times out of eleven. When it cannot be proven, the scan is left alone rather than guessed at. Separately, product barcodes are only ever looked up when the code could actually be one: a real product barcode is a fixed run of digits, so an eighteen character mix of letters and numbers is no longer handed to a product database that will cheerfully return its best guess. The repaired VIN also replaces the mangled one on the record, so you are not left holding a code that exists nowhere.
