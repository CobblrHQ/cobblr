---
type: fix
scope: scan
date: 2026-10-07
---
**A grocery scanned without AI files to Groceries, and its brand reads as the brand.** A box of pasta could arrive with its name and brand but none of its food categories, and in a workspace whose food table is Groceries it was filed as an Inventory part. Cobblr now reads those categories when they are missing. A brand also drops the company's legal form, so Coca-Cola no longer reads "COCA-COLA SERVICES SA/NV".
