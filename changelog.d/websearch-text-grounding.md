---
type: fix
date: 2026-06-22
---
Barcodes that aren't in any database now resolve far more often. The web-search fallback used to ask DuckDuckGo's image index for a name (which can't resolve a bare UPC) so it usually came up blank. It now asks the text/web search too, which returns the actual product pages (e.g. a Cuisinart pan's UPC → "Cuisinart Chef's Classic Nonstick Hard Anodized 11″ Square Griddle"), giving the AI real titles to identify from.
