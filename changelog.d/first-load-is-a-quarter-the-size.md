---
type: improvement
scope: performance
date: 2026-10-05
---
The app downloads about a quarter of what it used to before the first page appears: each section, dialog and heavy tool (the barcode reader, QR codes, Markdown, PDFs) now loads when you open it, and the section you point at starts loading before you click, so it still opens at once. On a slow phone connection the dashboard appears about two seconds sooner and the scan inbox about four.
