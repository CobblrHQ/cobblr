---
type: feature
---
Scanning is now **type-aware**. Cobblr recognises what kind of code you scanned and routes it to the right place instead of running everything through the product-barcode databases: a **UPC/EAN** goes to the barcode chain, an **ISBN** is looked up as a **book** (Open Library — title, author, cover), a real **Amazon ASIN** tries the product page, an **Amazon FNSKU** (the `X00…` warehouse labels) is recognised as un-lookupable and sent straight to "name it" (no more endless "rate-limited — retrying"), and a **URL** goes to the maker-page resolver. The upshot: non-barcodes no longer waste a barcode lookup or get falsely stuck as rate-limited, and books/Amazon items identify better.
