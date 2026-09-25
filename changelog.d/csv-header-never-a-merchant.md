---
type: fix
scope: scan
date: 2026-09-25
---
A CSV of purchases with no shop in it no longer files its column header ("description,qty,unit price,amount") as the shop every line came from. The shop is taken only from a column that names one, and is left blank otherwise.
