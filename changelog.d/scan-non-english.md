---
type: fix
---
When a barcode provider returns a localized, non-English product name (e.g. go-upc handing back "Charmin Papel Higiénico Ultra Soft" for a US item), the scanner now automatically re-identifies it from the web, which prefers English — so you get the English name for the same product.
